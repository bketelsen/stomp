// The Delegation task: deliver a brief to a thread, wait for the review of its commits, then report the thread's answer
// and the verdict to the supervisor that delegated it. Checkpoints and request ids make every phase restart-safe; there
// is no recovery code.
//
// The wait rule (pi-durable doesn't detect wait cycles, #10411): no supervisor tool waits on a Delegation or a thread
// without aborting it first, and agents get no tools that wait on other conversations. This task's own waits are safe.
import type { Context } from "@earendil-works/chord";
import {
	AssistantEntry,
	type ConversationId,
	defineTask,
	type EntryId,
	type EntryRecord,
	type TaskOutcome,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export const DELEGATION = "stomp.delegation";

export type DelegationInput = { agent: string; thread: number; brief: string; mode: "followUp" | "steer" };
type DelegationState =
	| { phase: "deliver" }
	| { phase: "review"; first: number }
	| { phase: "report"; text: string; key: string; failed?: true; attempt?: number };

/** The review line for a thread's commits, once reviewed; undefined without commits or with review off. */
export type Reviewed = (
	rt: TaskRuntime<DelegationInput, DelegationState, null, object>,
	thread: ConversationId,
	c: Context,
) => Promise<string | undefined>;

/** A final answer: an assistant message that ended without tool calls or an error. */
function answerOf(entry: EntryRecord | undefined): { id: number; text: string } | undefined {
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	if (!AssistantEntry.is(entry) || (message?.stopReason !== "stop" && message?.stopReason !== "length")) return undefined;
	const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
	return { id: entry.id, text: text || "(no text)" };
}

export type DelegationTask = ReturnType<typeof delegationTask>;

export const delegationTask = (nameOf: (agent: string) => string, reviewed?: Reviewed) =>
	defineTask<DelegationInput, DelegationState, null>({
		name: DELEGATION,
		version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (task, rt, c) => {
				const { thread, brief, mode } = task.input;
				const handle = (await rt.conversation(thread as ConversationId, c))!;
				const request = { type: "input", content: brief, whenBusy: mode, requestId: `deliver:${task.id}` } as const;
				const settled = await (await handle.submit(request, c)).wait(c);
				if (settled.status !== "done") {
					// Stopped in the thread itself: Brian knows, so nothing to report.
					if (settled.reason === "aborted") return rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c);
					const failed = { phase: "report", text: `failed: ${settled.reason}`, key: `report:${task.id}`, failed: true } as const;
					return rt.commit(() => ({ status: "running", checkpoint: failed }), c);
				}
				await rt.commit(() => ({ status: "running", checkpoint: { phase: "review", first: settled.answer! } }), c);
			},
			review: async (task, rt, c) => {
				const thread = task.input.thread as ConversationId;
				const { first } = task.state.checkpoint;
				const line = await reviewed?.(rt, thread, c);
				// Every answer since the brief's, collected after the review: a steer or follow-up Brian typed mid-work,
				// and the author's replies to the reviewer, add to the report instead of replacing the brief's answer.
				await (await rt.conversation(thread, c))!.waitForIdle(c);
				const since = (await rt.context(thread, c)).entries.flatMap((e) => (e.id >= first ? (answerOf(e) ?? []) : []));
				await rt.commit(async (tx) => {
					const answers = since.length > 0 ? since : [answerOf(await tx.entry(first as EntryId)) ?? { id: first, text: "(no text)" }];
					const text = [...answers.map((answer) => answer.text), ...(line ? [line] : [])].join("\n\n");
					// Keyed by the last answer, not the task: two deliveries answered by one run report once.
					return { status: "running", checkpoint: { phase: "report", text, key: `report:${thread}:${answers.at(-1)!.id}` } };
				}, c);
			},
			report: async (task, rt, c) => {
				const { text, key, failed, attempt = 0 } = task.state.checkpoint;
				const content = `[report from ${nameOf(task.input.agent)}, thread ${task.input.thread}] ${text}`;
				const supervisor = (await rt.conversation(rt.conversationId, c))!;
				const request = { type: "input", content, whenBusy: "followUp", requestId: attempt ? `${key}:${attempt}` : key } as const;
				const settled = await (await supervisor.submit(request, c)).wait(c);
				// Esc on the supervisor withdraws queued input, reports included: queue it again.
				if (settled.status === "unanswered" && settled.entry === undefined) {
					return rt.commit(() => ({ status: "running", checkpoint: { ...task.state.checkpoint, attempt: attempt + 1 } }), c);
				}
				const outcome: TaskOutcome<null> = failed ? { status: "failed", error: { message: text } } : { status: "completed", result: null };
				await rt.commit(() => ({ status: "terminal", outcome }), c);
			},
		},
		abort: (_task, rt, c) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c),
	});
