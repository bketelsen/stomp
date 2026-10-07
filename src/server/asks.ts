// Asks: a command the judge didn't clear waits in memory for Brian. The guard is a beforeTool hook on bash, on file tools
// that touch stomp's own files and on MCP tools, installed in every extension that provides them (stomp-coding,
// stomp-review, mcp-<name>): a hook runs only where its extension is selected, so the tools and their guard travel
// together. It runs before pi-durable commits the tool's intent, so after a restart it simply runs again and asks again
// under the same id, and an answer given before a crash replays from the memo (spike q5).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { AgentDoc, type Harness, type HookApi, type HookRegistration, hook, ToolTask } from "@earendil-works/pi-durable";
import { isSeq, parseDocument } from "yaml";
import type { Ask, AskAnswer } from "../shared/protocol.ts";
import type { Judge, Segment, Verdict } from "./judge.ts";
import type { Judged } from "./mcp.ts";
import { ThreadsDoc } from "./threads.ts";

/** Hooks share the tool task's memo namespace, so the key is prefixed. */
const MEMO = "stomp-judge:answer";
type Answer = { decision: AskAnswer["decision"]; note: string };

export type Asks = ReturnType<typeof createAsks>;

/** "Always allow for <agent>": each segment no rule allowed joins allowed.yaml exactly as it was, keeping what's there. Brian widens by editing. */
export function learn(file: string, agent: string, open: readonly Segment[]): void {
	const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
	if (doc.errors.length) throw new Error(`${file} is malformed`);
	const path = ["agents", agent, "allow"];
	for (const pattern of open.map((seg) => `re:^${seg.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)) {
		const seq = doc.getIn(path);
		if (!isSeq(seq)) doc.setIn(path, [pattern]);
		else if (!seq.items.some((item) => (item as { value?: unknown }).value === pattern)) doc.addIn(path, pattern);
	}
	writeFileSync(file, doc.toString());
}

export function createAsks(judge: Judge, stateDir: string) {
	const pending = new Map<string, { ask: Ask; verdict: Verdict; resolve(answer: Answer): void }>();
	const listeners = new Set<() => void>();
	const changed = () => listeners.forEach((listener) => listener());
	return {
		/** Oldest first. */
		list: (): Ask[] => [...pending.values()].map((entry) => entry.ask),
		onChange(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Brian's answer; false for an unknown or expired id. The tool goes ahead first, then "always" saves its segments: a failed save throws. */
		answer(id: string, { decision, note }: AskAnswer): boolean {
			const entry = pending.get(id);
			if (entry === undefined) return false;
			pending.delete(id);
			const { why: _why, open, ...line } = entry.verdict;
			judge.record({ ...line, at: Date.now(), answer: decision });
			entry.resolve({ decision, note: note?.trim() ?? "" });
			try {
				if (decision === "always" && open.length) learn(join(stateDir, "allowed.yaml"), entry.ask.agent, open);
			} catch (error) {
				throw new Error(`allowed once, but "always" wasn't saved: ${(error as Error).message}`);
			}
			return true;
		},
		/** Until Brian answers or `context` is cancelled (abort, close); either way the ask leaves the list. */
		async wait(ask: Ask, verdict: Verdict, context: Context): Promise<Answer> {
			const { promise, resolve } = Promise.withResolvers<Answer>();
			pending.set(ask.id, { ask, verdict, resolve });
			changed();
			try {
				return await awaitWithContext(promise, context);
			} finally {
				pending.delete(ask.id);
				changed();
			}
		},
	};
}

/** Where a call runs: a thread and its agent, or a reviewer, whose asks show on the thread it reviews. */
async function placeOf(api: HookApi, harness: () => Harness, c: Context): Promise<Pick<Ask, "thread" | "agent" | "cwd">> {
	const id = api.conversationId;
	const cwd = (await api.snapshot(AgentDoc, id, c))?.cwd ?? "";
	const row = (await api.snapshot(ThreadsDoc, c))?.threads[id];
	if (row !== undefined) return { thread: id, agent: row.agent, cwd };
	// A reviewer's conversation belongs to a Review task of the author's thread.
	const record = await harness().commit((tx) => tx.conversation(id), c);
	return { thread: record?.owner?.conversationId ?? id, agent: "reviewer", cwd };
}

/** A file tool's `path` (`~` expanded, `@` dropped as pi-durable does) is in stomp's own files, resolved from the call's cwd. */
async function ownFile(judge: Judge, api: HookApi, path: string, c: Context): Promise<boolean> {
	const cwd = (await api.snapshot(AgentDoc, api.conversationId, c))?.cwd ?? "";
	return judge.own(resolve(cwd, path.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir())));
}

const bash: Judged = (name, args) => (name === "bash" ? String(args.command ?? "") : undefined);

/**
 * The guard: run what the judge clears; otherwise ask Brian and do what he says. Nothing automated says no. It judges
 * bash's commands and file tools' paths; an MCP extension's guard judges its own tools' calls instead (mcp.ts).
 */
export function stompGuard(judge: Judge, asks: Asks, harness: () => Harness, judged = bash): HookRegistration {
	return hook(ToolTask, {
		beforeTool: async (call, api, context) => {
			// Every other tool runs unasked, and so do file tools (read, write, edit, read_file) outside stomp's own files.
			const shell = judged(call.name, call.arguments);
			const file = shell === undefined && judged === bash ? call.arguments.path : undefined;
			if (typeof file === "string" ? !(await ownFile(judge, api, file, context)) : shell === undefined) return undefined;
			let answer = await api.memo<Answer>(MEMO, context);
			if (answer === undefined) {
				const command = typeof file === "string" ? `${call.name} ${file}` : shell!;
				const place = await placeOf(api, harness, context);
				const asked = (by: "ask-rule" | "fallback", detail: string, why: string): Verdict => {
					const line = { at: Date.now(), thread: place.thread, agent: place.agent, command, outcome: "ask", by, detail } as const;
					judge.record(line);
					return { ...line, why, open: [] };
				};
				const verdict =
					typeof file === "string"
						? asked("ask-rule", "stomp's own files", "rule: stomp's own files")
						: await judge.decide({ command, ...place }, context.abortSignal).catch((error: Error): Verdict => {
								// A throwing hook blocks the call, which would be a machine saying no: a broken judge asks instead.
								context.abortSignal?.throwIfAborted();
								return asked("fallback", String(error), `no judge: ${error.message}`);
							});
				if (verdict.outcome === "run") return undefined;
				const once = typeof file === "string" ? { once: true as const } : {};
				const ask: Ask = { id: `${api.taskId}:${call.id}`, ...place, command, why: verdict.why, createdAt: Date.now(), ...once };
				answer = await api.memo<Answer>(MEMO, await asks.wait(ask, verdict, context), context);
			}
			return answer.decision === "deny" ? { block: `Brian declined: ${answer.note || "no reason given"}` } : undefined;
		},
	});
}
