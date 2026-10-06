// Consults: any agent can ask another a question. An ephemeral copy of the other agent answers: a conversation owned
// by this tool call, with that agent's model, soul and notebook, and read-only tools, so it can't consult, delegate,
// remember or change anything. Waiting on it is safe: it's the call's own child, never a long-lived conversation.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTool, type Extension, type HookRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { type AgentConfig, notebookText } from "./agents.ts";
import { fetchTool, readFileTool } from "./readonly.ts";
import { ThreadsDoc } from "./threads.ts";

const CONSULT = "Answer a teammate's question briefly, as three short parts: Observed, Inferred, Unknown. You can read files and fetch pages; you can't change anything.";

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });

export function stompConsult(host: { agents(): readonly AgentConfig[]; guard: HookRegistration }) {
	// The copy's only tools. Its reads of stomp's own files ask Brian, as an agent's do.
	const extension = defineExtension({ name: "stomp-consult", tools: [readFileTool(), fetchTool], hooks: [host.guard] }) as Extension;

	const tool = defineTool({
		name: "consult",
		description:
			"Ask a teammate a question and wait for a brief answer: what they observed, inferred and don't know. A read-only copy of them answers, with their notebook; it can read files and fetch pages, and starts no work.",
		parameters: Type.Object({ agent: Type.String({ description: "The teammate's id" }), question: Type.String() }),
		// A rerun after a restart finds the child it created and the question it submitted (pi-durable example 22).
		replay: "safe",
		execute: async ({ agent: key, question }, api, c) => {
			const me = (await api.snapshot(ThreadsDoc, c))?.threads[api.conversationId]?.agent;
			const target = host.agents().find((a) => a.id === key || a.name.toLowerCase() === key.toLowerCase());
			if (target === undefined) return reply(`No agent "${key}". The team: ${host.agents().map((a) => a.id).join(", ")}.`, true);
			if (target.id === me) return reply("That's you.", true);
			if (target.error !== undefined) return reply(`${target.name} can't answer: ${target.error}`, true);
			// Its notebook goes in the instructions: a notebook section only finds threads' agents.
			const instructions = `${target.instructions}\n\n<notebook>\n${notebookText(target)}\n</notebook>\n\n${CONSULT}`;
			const child = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) return existing.id;
				// A task-owned conversation starts as a copy of the caller's agent: set everything to the target's.
				const { id } = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				const model = { provider: target.provider, modelId: target.modelId };
				await configure(tx, id, { model, thinkingLevel: target.thinking, instructions, cwd: target.cwd, extensions: [extension] });
				return id;
			}, c);
			const request = { type: "input", content: question, requestId: `consult:${api.taskId}` } as const;
			const settled = await (await (await api.conversation(child, c))!.submit(request, c)).wait(c);
			if (settled.status !== "done") return reply(`${target.name} couldn't answer: ${settled.reason}`, true);
			const message = (await api.commit((tx) => tx.entry(AssistantEntry, settled.answer!), c))?.model?.[0] as AssistantMessage | undefined;
			const text = message?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
			return reply(`[consult ${target.name}] ${text || "(no answer)"}`);
		},
	});
	return { tool, extension };
}
