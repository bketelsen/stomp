// Duties: scheduled checks in agent files and duties.yaml. Level-triggered: at startup and every minute, each duty last
// run at least `every` ago runs its check (Brian's config, or judged when the supervisor set it) in the agent's cwd, with
// the agent's shell environment, and records the result in `stomp.duties`. A duty without a check wakes every time.
// When the result calls for it, the agent is woken: with a supervisor, by a Delegation from the supervisor's desk in a
// new thread, so the finding comes back as a report; without one, in its desk.
// A run's record and its Delegation land in one commit, and a desk wake is keyed by the run it follows, so a crash
// between the check and the commit re-runs the check and never wakes twice.
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { DutyInfo } from "../shared/protocol.ts";
import type { AgentConfig, Duty } from "./agents.ts";
import type { DelegationTask } from "./delegation.ts";
import { type ExtensionsFor, openThread, ThreadsDoc } from "./threads.ts";

const TIMEOUT_SECONDS = 60;
const OUTPUT_CAP = 8 * 1024;

/** The hash covers the exit code and the output, so `changed` notices a check that starts failing silently. */
type DutyRecord = { lastRun: number; lastExit: number; lastHash: string; lastWoke?: number; lastOutput?: string };

/** Each duty's last run, keyed `<agent>/<duty>`. */
export const DutiesDoc = defineDoc<{ duties: Record<string, DutyRecord> }>({
	kind: "stomp.duties",
	version: 1,
	scope: "session",
	initial: () => ({ duties: {} }),
});

export type DutyHost = {
	agents(): readonly AgentConfig[];
	extensions: ExtensionsFor;
	delegation: DelegationTask;
	/** The environment agents' shells get. */
	env(cwd: string): ExecutionEnv;
	/** How often to look for due duties, and the clock (both injectable for tests). */
	tickMs: number;
	now(): number;
};

/** AgentInfo's duties: the agent file's and duties.yaml's, with their last runs. */
export function dutyInfo(agent: AgentConfig, records: Readonly<Record<string, DutyRecord>>, now: number): DutyInfo[] {
	return agent.duties.map(({ name, every, ms, added }) => {
		const r = records[`${agent.id}/${name}`];
		const woke = r?.lastWoke === undefined ? {} : { lastWoke: r.lastWoke };
		return { name, every, ...(added && { added }), ...(r && { lastRun: r.lastRun, lastExit: r.lastExit, ...woke }), next: (r?.lastRun ?? now) + ms };
	});
}

/** The check through the agents' shell, with a timeout; stdout and stderr together, cut at 8 KB. */
async function runCheck(env: ExecutionEnv, command: string, c: Context): Promise<{ exit: number; output: string }> {
	let output = "";
	const onOutput = (text: string) => void (output.length < OUTPUT_CAP && (output += text));
	const result = await env.exec(command, { timeout: TIMEOUT_SECONDS, onOutput }, c);
	output = output.slice(0, OUTPUT_CAP).trimEnd();
	if (result.ok) return { exit: result.value.exitCode, output };
	return { exit: result.error.code === "timeout" ? 124 : 127, output: `${output}\n[${result.error.message}]`.trim() };
}

/** Returns a stop function that waits for a tick in flight. */
export function startDuties(harness: Harness, host: DutyHost): () => Promise<void> {
	const stop = new AbortController();
	const c = withAbortSignal(stop.signal, ctx);

	async function run(agent: AgentConfig, duty: Duty, key: string, prev: DutyRecord | undefined): Promise<void> {
		const threads = Object.entries((await harness.snapshot(ThreadsDoc, c))?.threads ?? {});
		const deskOf = (id: string | undefined) => threads.find(([, t]) => t.agent === id && t.desk)?.[0];
		const boss = deskOf(host.agents().find((a) => a.role === "supervisor" && a.error === undefined)?.id);
		const desk = deskOf(agent.id);
		// A new agent's desk comes with the reload that loaded it: until then, its duties wait.
		if (desk === undefined) return;
		const { exit, output } = duty.check === undefined ? { exit: 0, output: "" } : await runCheck(host.env(agent.cwd), duty.check, c);
		if (stop.signal.aborted) return;
		const now = host.now();
		const hash = createHash("sha256").update(`${exit}\n${output}`).digest("hex");
		// The first run of a `changed` duty is its baseline.
		// "changed": a different result than last time; a first run is a baseline unless it already fails.
		const changed = prev === undefined ? exit !== 0 : prev.lastHash !== hash;
		const wake = duty.wake === "always" || (duty.wake === "failed" ? exit !== 0 : changed);
		// Before and now, so the agent can see what changed.
		const before = prev?.lastOutput === undefined ? "" : `\n\nThe last run (exit ${prev.lastExit}) printed:\n${prev.lastOutput || "(no output)"}`;
		const ran = duty.check === undefined ? "" : `\n\nThe check ran \`${duty.check}\` (exit ${exit}):\n${output || "(no output)"}${before}`;
		const brief = `[duty ${duty.name}] ${duty.brief}${ran}`;
		if (wake && boss === undefined) {
			// No supervisor: the agent's desk, keyed by the run this one follows, so a re-run after a crash dedupes.
			const request = { type: "input", content: brief, whenBusy: "followUp", requestId: `duty:${key}:${prev?.lastRun ?? 0}` } as const;
			await (await harness.conversation(Number(desk) as ConversationId, c))?.submit(request, c);
		}
		await harness.commit(async (tx) => {
			const woke = wake ? now : prev?.lastWoke;
			const record = { lastRun: now, lastExit: exit, lastHash: hash, lastOutput: output };
			(await tx.doc(DutiesDoc)).duties[key] = { ...record, ...(woke === undefined ? {} : { lastWoke: woke }) };
			if (!wake || boss === undefined) return;
			const row = { title: `duty: ${duty.name}`, desk: false, delegatedBy: Number(boss) };
			const thread = await openThread(tx, agent, host.extensions, row);
			const options = { ownership: { kind: "conversation" }, conversationId: Number(boss) as ConversationId, background: true } as const;
			await tx.createTask(host.delegation, { agent: agent.id, thread, brief, mode: "followUp" }, options);
		}, c);
	}

	const tick = async () => {
		const now = host.now();
		const records = (await harness.snapshot(DutiesDoc, c))?.duties ?? {};
		const runs = host.agents().flatMap((agent) =>
			agent.error !== undefined
				? []
				: agent.duties.flatMap((duty) => {
						const key = `${agent.id}/${duty.name}`;
						const prev = records[key];
						if (prev !== undefined && now < prev.lastRun + duty.ms) return [];
						return [run(agent, duty, key, prev).catch((error: unknown) => void (stop.signal.aborted || console.error(`[stomp] duty ${key}`, error)))];
					}),
		);
		await Promise.all(runs);
	};
	let running: Promise<void> | undefined;
	const soon = () => {
		running ??= tick()
			.catch((error: unknown) => void (stop.signal.aborted || console.error("[stomp] duties", error)))
			.finally(() => (running = undefined));
	};
	soon();
	const timer = setInterval(soon, host.tickMs);
	return async () => {
		clearInterval(timer);
		stop.abort();
		await running;
	};
}
