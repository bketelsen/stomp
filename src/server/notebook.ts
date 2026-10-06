// Notebooks: `$STOMP_STATE/notes/<agent>.md`, plain markdown that every thread of the agent sees as a prompt section.
// Agents add to theirs with `remember` and tidy it with `notebook`; Brian edits it in the UI. Writes are atomic.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { type AgentConfig, notebookText, readOptional } from "./agents.ts";
import { ThreadsDoc } from "./threads.ts";

/** Past this many lines, `remember` asks the agent to tidy up. */
export const NOTEBOOK_CAP = 150;
export const NOTEBOOK_MAX_BYTES = 64 * 1024;

export type Notebooks = ReturnType<typeof notebooks>;

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "").length;

/** `changed` is told after every write, so the agent's line count reaches the UI. */
export function notebooks(agents: () => readonly AgentConfig[], changed: () => void) {
	// Synchronous, so two threads of one agent can't interleave a read and a write.
	const write = (agent: AgentConfig, text: string): void => {
		mkdirSync(dirname(agent.notebook), { recursive: true });
		writeFileSync(`${agent.notebook}.tmp`, text);
		renameSync(`${agent.notebook}.tmp`, agent.notebook);
		changed();
	};
	/** The agent whose thread a call or a request is in. */
	const agentOf = async (docs: Pick<ToolExecutionApi, "snapshot">, conversationId: number, c: Context) => {
		const id = (await docs.snapshot(ThreadsDoc, c))?.threads[conversationId]?.agent;
		return agents().find((agent) => agent.id === id);
	};
	const NOT_A_THREAD = reply("This conversation isn't a stomp thread.", true);

	const remember = defineTool({
		name: "remember",
		description: "Save a short note worth knowing next time: a fact, a decision, where something lives. It goes in your notebook, which every thread of yours sees.",
		parameters: Type.Object({ note: Type.String() }),
		execute: async ({ note }, api, c) => {
			const agent = await agentOf(api, api.conversationId, c);
			if (agent === undefined) return NOT_A_THREAD;
			const before = readOptional(agent.notebook);
			const line = `- ${new Date().toISOString().slice(0, 10)}: ${note.trim().replace(/\s*\n\s*/g, " ")}\n`;
			const text = `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${line}`;
			write(agent, text);
			const n = lines(text);
			const full = ` Your notebook is full (${n} lines; the cap is ${NOTEBOOK_CAP}). Tidy it now: merge, shorten and drop stale notes, then save the whole notebook with notebook({text}).`;
			return reply(`Remembered.${n > NOTEBOOK_CAP ? full : ""}`);
		},
	});

	const notebook = defineTool({
		name: "notebook",
		description: "Replace your whole notebook with `text`, to tidy it: merge, shorten, drop what's stale.",
		parameters: Type.Object({ text: Type.String() }),
		execute: async ({ text }, api, c) => {
			const agent = await agentOf(api, api.conversationId, c);
			if (agent === undefined) return NOT_A_THREAD;
			if (Buffer.byteLength(text) > NOTEBOOK_MAX_BYTES) return reply(`Too long: a notebook holds ${NOTEBOOK_MAX_BYTES / 1024} KB.`, true);
			write(agent, text.trimEnd() ? `${text.trimEnd()}\n` : "");
			return reply(`Saved your notebook (${lines(text)} of ${NOTEBOOK_CAP} lines).`);
		},
	});

	const notebookSection = section("notebook", async ({ conversationId, read }, c) => {
		const agent = await agentOf(read, conversationId, c);
		return agent && notebookText(agent);
	});

	return { write, lines: (agent: AgentConfig) => lines(readOptional(agent.notebook)), tools: [remember, notebook], section: notebookSection };
}
