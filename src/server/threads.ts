// Threads: ownerless conversations, each named in the session doc `stomp.threads` in the commit that creates it.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
	type AgentChange,
	type ConversationId,
	configure,
	defineDoc,
	type Extension,
	type Harness,
	SystemEntry,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ReviewRecord } from "../shared/protocol.ts";
import { type AgentConfig, notebookText } from "./agents.ts";

/** Where a bound thread works: its repo, its worktree (the thread's cwd), branch, and the commit it started from. */
export type Binding = { repo: string; worktree: string; branch: string; base: string };

/** protocol.ts's interfaces as plain object types, which a doc can store. */
type Plain<T> = { [K in keyof T]: T[K] extends (infer U)[] ? Plain<U>[] : T[K] };

export type ThreadRecord = { agent: string; title: string; desk: boolean; createdAt: number; delegatedBy?: number } & Partial<Binding> & {
	/** The HEAD a Review was last started for: one attempt per commit, even if that Review faults. */
	requested?: string;
	review?: Plain<ReviewRecord>;
};

export const ThreadsDoc = defineDoc<{ threads: Record<string, ThreadRecord> }>({
	kind: "stomp.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: {} }),
});

/** Every thread gets an explicit extension array: the default selection would hand agents every installed extension. */
export type ExtensionsFor = (agent: AgentConfig) => Extension[];

export async function listThreads(harness: Harness): Promise<Readonly<Record<string, ThreadRecord>>> {
	return (await harness.snapshot(ThreadsDoc, ctx))?.threads ?? {};
}

const agentChange = (agent: AgentConfig, extensions: ExtensionsFor, cwd = agent.cwd): AgentChange => ({
	model: { provider: agent.provider, modelId: agent.modelId },
	thinkingLevel: agent.thinking,
	instructions: agent.instructions,
	cwd,
	extensions: extensions(agent),
});

/**
 * Inside a commit: the conversation, its agent, the notebook and instructions seeded as its first system entry, and its
 * row. Seeding puts the soul in the top-level system prompt; otherwise pi-durable sends it after the first user message
 * (#10542). The sections are seeded in the order pi-durable renders them, so the first request doesn't reorder them.
 */
export async function openThread(
	tx: Tx,
	agent: AgentConfig,
	extensions: ExtensionsFor,
	row: { title: string; desk: boolean; delegatedBy?: number },
): Promise<ConversationId> {
	const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
	await configure(tx, id, agentChange(agent, extensions));
	const sections = { notebook: `<notebook>\n${notebookText(agent)}\n</notebook>`, instructions: `<instructions>\n${agent.instructions}\n</instructions>` };
	await tx.appendEntry(SystemEntry, id, { model: [{ role: "system", content: "", sections, timestamp: Date.now() }] });
	(await tx.doc(ThreadsDoc)).threads[id] = { agent: agent.id, ...row, createdAt: Date.now() };
	return id;
}

/** Inside a commit: record the binding and make the worktree the thread's cwd. */
export async function bindThread(tx: Tx, thread: ConversationId, binding: Binding): Promise<void> {
	Object.assign((await tx.doc(ThreadsDoc)).threads[thread]!, binding);
	await configure(tx, thread, { cwd: binding.worktree });
}

export const createThread = (harness: Harness, agent: AgentConfig, extensions: ExtensionsFor, title: string, desk: boolean) =>
	harness.commit((tx) => openThread(tx, agent, extensions, { title, desk }), ctx);

/** Level-triggered: each valid agent has exactly one desk thread, and every thread matches its agent's file. */
export async function syncThreads(harness: Harness, agents: readonly AgentConfig[], extensions: ExtensionsFor): Promise<void> {
	const threads = await listThreads(harness);
	const valid = new Map(agents.filter((agent) => agent.error === undefined).map((agent) => [agent.id, agent]));
	for (const agent of valid.values()) {
		const hasDesk = Object.values(threads).some((thread) => thread.agent === agent.id && thread.desk);
		if (!hasDesk) await createThread(harness, agent, extensions, agent.name, true);
	}
	// An unchanged configuration writes nothing, so this is cheap when no file changed.
	await harness.commit(async (tx) => {
		for (const [id, thread] of Object.entries(threads)) {
			const agent = valid.get(thread.agent);
			if (agent !== undefined) await configure(tx, Number(id) as ConversationId, agentChange(agent, extensions, thread.worktree));
		}
	}, ctx);
}
