// The StateSnapshot, derived on demand from the agent files, `stomp.threads`, pi-durable's task graph and task records,
// `pi.usage` and the in-memory asks. Nothing here is stored: a thread needs Brian while one of its commands waits for his
// answer, else it's working exactly while a generation task of its conversation is live, reviewing while a Review task
// of it is, and a delegation stands where its latest Delegation task does.
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { type Cursor, GenerationTask, type Harness, type TaskRecord } from "@earendil-works/pi-durable";
import type { AgentInfo, DelegationStatus, ProviderUsage, StateSnapshot, ThreadInfo, ThreadStatus } from "../shared/protocol.ts";
import type { AgentConfig } from "./agents.ts";
import type { Asks } from "./asks.ts";
import { DELEGATION, type DelegationInput } from "./delegation.ts";
import { DutiesDoc, dutyInfo } from "./duties.ts";
import type { Notebooks } from "./notebook.ts";
import { REVIEW } from "./review.ts";
import { listThreads, ThreadsDoc } from "./threads.ts";

export type StateFeed = {
	snapshot(): Promise<StateSnapshot>;
	/** Push a fresh snapshot to subscribers soon, if it changed. */
	changed(): void;
	subscribe(listener: (state: StateSnapshot) => void): () => void;
	close(): void;
};

const GENERATION = GenerationTask.definition.name;
/** Task outcomes to delegation statuses; a live task is running, and faulted or orphaned ones failed. */
const OUTCOMES: Record<string, DelegationStatus> = { completed: "reported", aborted: "cancelled" };

export async function watchState(
	harness: Harness,
	agents: () => readonly AgentConfig[],
	models: Models,
	providerIds: readonly string[],
	asks: Asks,
	notes: Pick<Notebooks, "lines">,
): Promise<StateFeed> {
	const graph = await harness.taskGraph(ctx);
	const status = (thread: number): ThreadStatus => {
		if (asks.list().some((ask) => ask.thread === thread)) return "needs-you";
		const kinds = Object.values(graph.value.tasks).flatMap((task) => (task.conversationId === thread ? [task.kind] : []));
		return kinds.includes(GENERATION) ? "working" : kinds.includes(REVIEW) ? "reviewing" : "idle";
	};

	/** Each thread's latest Delegation decides, terminal ones included. */
	async function delegations(): Promise<Map<number, DelegationStatus>> {
		const tasks = await harness.commit(async (tx) => {
			const all: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
			let next: Cursor | undefined;
			do {
				const page = await tx.scanTasks({ kind: DELEGATION }, 500, next);
				all.push(...page.items);
				next = page.next;
			} while (next);
			return all;
		}, ctx);
		const latest = new Map<number, DelegationStatus>();
		for (const task of tasks.sort((a, b) => a.id - b.id)) {
			const outcome = task.state.outcome?.status;
			latest.set((task.input as DelegationInput).thread, outcome === undefined ? "running" : (OUTCOMES[outcome] ?? "failed"));
		}
		return latest;
	}

	/** Tokens per provider over every conversation's `pi.usage`; input includes cache reads and writes, like the UI. */
	async function usage(): Promise<ProviderUsage[]> {
		const byProvider = new Map<string, ProviderUsage>();
		for (const [key, u] of Object.entries((await harness.usage(ctx)).models)) {
			const provider = key.slice(0, key.indexOf("/"));
			const sum = byProvider.get(provider) ?? { provider, input: 0, output: 0 };
			byProvider.set(provider, { provider, input: sum.input + u.input + u.cacheRead + u.cacheWrite, output: sum.output + u.output });
		}
		return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
	}

	async function snapshot(): Promise<StateSnapshot> {
		const records = await listThreads(harness);
		const delegated = await delegations();
		const duties = (await harness.snapshot(DutiesDoc, ctx))?.duties ?? {};
		const byAgent = new Map(agents().map((agent) => [agent.id, agent]));
		const threads: ThreadInfo[] = Object.entries(records).map(([id, t]) => {
			const delegation = delegated.get(Number(id));
			return {
				id: Number(id),
				agent: t.agent,
				// A desk is titled after its agent, whose name may have changed since.
				title: t.desk ? (byAgent.get(t.agent)?.name ?? t.title) : t.title,
				desk: t.desk,
				createdAt: t.createdAt,
				status: status(Number(id)),
				...(t.delegatedBy === undefined ? {} : { delegatedBy: t.delegatedBy }),
				...(delegation === undefined ? {} : { delegation }),
				...(t.repo === undefined ? {} : { repo: t.repo, branch: t.branch! }),
				...(t.review === undefined ? {} : { review: t.review }),
			};
		});
		const agentInfos: AgentInfo[] = agents().map((agent) => {
			const own = threads.filter((thread) => thread.agent === agent.id);
			return {
				id: agent.id,
				name: agent.name,
				model: agent.model,
				provider: agent.provider,
				modelId: agent.modelId,
				family: agent.family,
				role: agent.role,
				// 0 when the agent has never loaded cleanly, so it has no desk yet.
				deskThread: own.find((thread) => thread.desk)?.id ?? 0,
				status: (["needs-you", "working", "reviewing"] as const).find((s) => own.some((thread) => thread.status === s)) ?? "idle",
				...(agent.error === undefined ? {} : { error: agent.error }),
				notes: notes.lines(agent),
				duties: dutyInfo(agent, duties, Date.now()),
			};
		});
		const providers = await Promise.all(
			providerIds.map(async (id) => ({ id, loggedIn: (await models.checkAuth(id).catch(() => undefined)) !== undefined })),
		);
		return { agents: agentInfos, threads, providers, usage: await usage(), asks: asks.list() };
	}

	const listeners = new Set<(state: StateSnapshot) => void>();
	let last = "";
	let timer: NodeJS.Timeout | undefined;
	const push = async () => {
		const state = await snapshot();
		const json = JSON.stringify(state);
		if (json === last) return;
		last = json;
		for (const listener of listeners) listener(state);
	};
	const changed = () => {
		timer ??= setTimeout(() => {
			timer = undefined;
			push().catch((error: unknown) => console.error("[stomp] state", error));
		}, 100);
	};
	const unsubscribe = harness.subscribeCommits(({ changes }) => {
		const relevant = (c: (typeof changes)[number]) =>
			(c.type === "task" && [GENERATION, DELEGATION, REVIEW].includes(c.value.kind)) ||
			(c.type === "document" && [ThreadsDoc.definition.kind, DutiesDoc.definition.kind].includes(c.record.kind));
		if (changes.some(relevant)) changed();
	});
	const unwatchAsks = asks.onChange(changed);
	return {
		snapshot,
		changed,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			unsubscribe();
			unwatchAsks();
			clearTimeout(timer);
			graph.dispose();
		},
	};
}
