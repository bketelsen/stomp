// stomp-supervisor: delegate, message, cancel, read and duty, the read-only tools, the guard, the Delegation task and the
// team section. Only the supervisor's threads select it. Tools never wait on a Delegation or a thread they haven't aborted.
import { writeFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, type Extension, type Harness, type HookRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { isMap, isSeq, parseDocument } from "yaml";
import type { StateSnapshot } from "../shared/protocol.ts";
import { type AgentConfig, dutyText, parseDuties, readOptional } from "./agents.ts";
import type { DelegationTask } from "./delegation.ts";
import type { Judged } from "./mcp.ts";
import { fetchTool, readFileTool } from "./readonly.ts";
import { stopThread } from "./stop.ts";
import { teamSection } from "./team.ts";
import { bindThread, type ExtensionsFor, openThread, ThreadsDoc } from "./threads.ts";
import type { Workspaces } from "./workspace.ts";

/** Late-bound: extensions are installed before `Harness.open` returns. */
export type SupervisorHost = {
	agents(): readonly AgentConfig[];
	extensions: ExtensionsFor;
	/** Tools can't abort tasks, so `cancel` goes through the host's Harness. */
	harness(): Harness;
	state(): Promise<StateSnapshot>;
	workspaces: Workspaces;
	/** The Delegation task, shared with duties. */
	delegation: DelegationTask;
	/** The guard, judging `judged`'s commands, or bash and stomp's own files by default (here: read_file's). */
	guard(judged?: Judged): HookRegistration;
	/** `$STOMP_STATE/duties.yaml`: the duties the supervisor adds. Agents reload when it changes. */
	dutiesFile: string;
};

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
const background = { ownership: { kind: "conversation" }, background: true } as const;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One message as compact text: role, text, and tool calls summarized. */
function compact(message: Message): string[] {
	if (message.role === "system") return [];
	const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	const parts = blocks.flatMap((b) =>
		b.type === "text" ? [b.text] : b.type === "toolCall" ? [`[${b.name} ${clip(JSON.stringify(b.arguments), 200)}]`] : [],
	);
	const role = message.role === "toolResult" ? `tool ${message.toolName}` : message.role;
	return [`${role}: ${clip(parts.join("\n").trim(), message.role === "toolResult" ? 300 : 2000)}`];
}

export function stompSupervisor(host: SupervisorHost): Extension {
	const agentOf = (key: string) => host.agents().find((a) => a.id === key || a.name.toLowerCase() === key.toLowerCase());
	const Delegation = host.delegation;
	const team = () => host.agents().filter((a) => a.role === "agent").map((a) => `${a.id} (${a.name})`).join(", ");

	const delegate = defineTool({
		name: "delegate",
		description: "Hand a job to a team member in a new thread. Returns at once; the report arrives later as a message starting with [report from ...].",
		parameters: Type.Object({
			agent: Type.String({ description: "The agent's id" }),
			brief: Type.String({ description: "The job, with everything they need to know" }),
			repo: Type.Optional(
				Type.String({
					description:
						'For a code change: "owner/name" on GitHub, or an absolute path to a local repo. They work in a worktree on a branch of their own, and their commits are reviewed before the report.',
				}),
			),
		}),
		execute: async ({ agent: key, brief, repo }, api, c) => {
			const agent = agentOf(key);
			if (agent === undefined) return reply(`No agent "${key}". The team: ${team()}.`, true);
			if (agent.role === "supervisor") return reply("That's you. Delegate to a team member.", true);
			if (agent.error !== undefined) return reply(`${agent.name} can't take work: ${agent.error}`, true);
			const source = repo === undefined ? undefined : await host.workspaces.source(repo);
			const line = brief.trim().split("\n")[0]!;
			const row = { title: clip(line, 60), desk: false, delegatedBy: api.conversationId };
			const input = (thread: number) => ({ agent: agent.id, thread, brief, mode: "followUp" }) as const;
			const thread = await api.commit(async (tx) => {
				const id = await openThread(tx, agent, host.extensions, row);
				if (source === undefined) await tx.createTask(Delegation, input(id), background);
				return id;
			}, c);
			// A worktree's path needs its thread's id, so a bound thread starts in a second commit, in its worktree.
			if (source !== undefined) {
				const binding = await host.workspaces.add(source, agent.id, thread);
				// Say where they are, or the house rule "work on a branch" makes them start another one.
				const where = `\n\n(You're in a worktree of ${binding.repo} at ${binding.worktree}, on branch ${binding.branch}. Commit there: another model reviews your commits.)`;
				await api.commit(async (tx) => {
					await bindThread(tx, thread, binding);
					await tx.createTask(Delegation, { ...input(thread), brief: brief + where }, background);
				}, c);
			}
			return { ...reply(`Delegated to ${agent.name} as thread ${thread}.`), details: { agent: agent.id, thread } };
		},
	});

	const message = defineTool({
		name: "message",
		description: "Send text into a thread: followUp (default) after its current work, or steer into it. Its answer is reported like a delegation's.",
		parameters: Type.Object({
			thread: Type.Number(),
			text: Type.String(),
			mode: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])),
		}),
		execute: async ({ thread, text, mode = "followUp" }, api, c) => {
			if (thread === api.conversationId) return reply("That's your own thread.", true);
			const sent = await api.commit(async (tx) => {
				const row = (await tx.doc(ThreadsDoc)).threads[thread];
				if (row !== undefined) await tx.createTask(Delegation, { agent: row.agent, thread, brief: text, mode }, background);
				return row !== undefined;
			}, c);
			return sent ? reply(`Sent to thread ${thread}.`) : reply(`No thread ${thread}.`, true);
		},
	});

	const cancel = defineTool({
		name: "cancel",
		description: "Stop a thread's work and its delegation. The thread stays open.",
		parameters: Type.Object({ thread: Type.Number() }),
		execute: async ({ thread }, api, c) => {
			const conversation = await api.conversation(thread as ConversationId, c);
			if (thread === api.conversationId || !(await api.snapshot(ThreadsDoc, c))?.threads[thread] || !conversation) {
				return reply(`No thread ${thread} to cancel.`, true);
			}
			const stopped = await stopThread(host.harness(), thread, c);
			// A report already queued behind this turn still arrives: the work did finish, and that's worth knowing.
			const note = stopped ? " If it had already finished, its report may still arrive." : "";
			return reply(`Cancelled thread ${thread}.${note}`);
		},
	});

	const read = defineTool({
		name: "read",
		description: "Without a thread: every thread, with its agent, title and status. With one: its last messages.",
		parameters: Type.Object({
			thread: Type.Optional(Type.Number()),
			last: Type.Optional(Type.Number({ description: "How many messages (default 10)" })),
		}),
		execute: async ({ thread, last = 10 }, _api, c) => {
			if (thread === undefined) {
				const { agents, threads } = await host.state();
				const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
				const rows = threads.map((t) => `${t.id} ${name(t.agent)}: ${t.title} (${t.status}${t.delegation ? `, delegation ${t.delegation}` : ""})`);
				return reply(rows.join("\n") || "No threads.");
			}
			const conversation = await host.harness().conversation(thread as ConversationId, c);
			if (conversation === undefined) return reply(`No thread ${thread}.`, true);
			const page = await conversation.entries({}, last * 2 + 10, undefined, c);
			const lines = page.items.toReversed().flatMap((entry) => entry.model ?? []).flatMap(compact).slice(-last);
			return reply(lines.join("\n\n") || "No messages yet.");
		},
	});

	const duty = defineTool({
		name: "duty",
		description:
			"Add, replace or remove a team member's scheduled duty. Every `every`, stomp runs the check in their shell and wakes them with the brief as `wake` says; without a check, it wakes them every time. What they find comes to you as a report.",
		parameters: Type.Object({
			agent: Type.String({ description: "The agent's id" }),
			name: Type.String({ description: "Short and unique for them, e.g. backups" }),
			remove: Type.Optional(Type.Boolean({ description: "Remove the duty you added with this name" })),
			every: Type.Optional(Type.String({ description: "Like 30m, 6h or 1d; at least 5m" })),
			brief: Type.Optional(Type.String({ description: "What they do when woken" })),
			check: Type.Optional(Type.String({ description: "A shell command, judged now like any command. Leave it out to wake them every time." })),
			wake: Type.Optional(
				Type.Union([Type.Literal("changed"), Type.Literal("failed"), Type.Literal("always")], {
					description: "With a check: when its output or exit changes (default), when it fails, or every time",
				}),
			),
		}),
		execute: async ({ agent: key, name, remove, ...fields }) => {
			const agent = agentOf(key);
			if (agent === undefined || agent.role === "supervisor") return reply(`No team member "${key}". The team: ${team()}.`, true);
			if (agent.duties.some((d) => d.name === name && !d.added)) return reply(`${agent.id}.md has a duty named ${name}; it's Brian's to change.`, true);
			// No await from here to the write, so parallel calls don't lose each other's changes.
			const doc = parseDocument(readOptional(host.dutiesFile));
			if (doc.errors.length) return reply(`duties.yaml is malformed, so Brian has to fix it first: ${doc.errors[0]!.message}`, true);
			const seq = doc.get(agent.id);
			const at = isSeq(seq) ? seq.items.findIndex((item) => isMap(item) && item.get("name") === name) : -1;
			if (remove) {
				if (at < 0) return reply(`You haven't added a duty named ${name} for ${agent.name}.`, true);
				const old = JSON.stringify(doc.getIn([agent.id, at]));
				doc.deleteIn([agent.id, at]);
				if (isSeq(seq) && seq.items.length === 0) doc.delete(agent.id);
				writeFileSync(host.dutiesFile, doc.toString());
				return reply(`Removed ${agent.name}'s duty ${name}. It was ${old}.`);
			}
			const entry = Object.fromEntries(Object.entries({ name, ...fields, check: fields.check?.trim() || undefined }).filter(([, v]) => v !== undefined));
			let parsed: string;
			try {
				parsed = dutyText(parseDuties([entry], "duties.yaml")[0]!);
			} catch (error) {
				return reply((error as Error).message.replace(/^duties\.yaml: /, ""), true);
			}
			if (at >= 0) doc.setIn([agent.id, at], entry);
			else if (isSeq(seq)) doc.addIn([agent.id], entry);
			else doc.set(agent.id, [entry]);
			writeFileSync(host.dutiesFile, doc.toString());
			return reply(`${at >= 0 ? "Replaced" : "Added"} ${agent.name}'s duty: ${parsed}`);
		},
	});
	// Brian's checks run unjudged, so one set here is judged as it's set: it runs every time after.
	const dutyCheck: Judged = (toolName, args) =>
		toolName === "duty" && !args.remove && typeof args.check === "string" ? args.check.trim() || undefined : undefined;

	return defineExtension({
		name: "stomp-supervisor",
		tools: [delegate, message, cancel, read, duty, readFileTool(), fetchTool],
		tasks: [Delegation],
		hooks: [host.guard(), host.guard(dutyCheck)],
		sections: [teamSection(host.agents)],
	}) as Extension;
}
