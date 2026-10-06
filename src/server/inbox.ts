// pi-durable leaves follow-ups queued after a failed run until the next submission places them (spec §12, "Queued
// items after a failed run"). Level-triggered: a thread that's idle with queued input gets a no-turn write, whose
// boundary places the queue and starts a run. It also runs at startup, so a restart needs nothing extra.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, GenerationTask, type Harness, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";

const GENERATION = GenerationTask.definition.name;

export function drainInboxes(harness: Harness, threadIds: () => Promise<number[]>): () => void {
	const check = async () => {
		for (const id of await threadIds()) {
			const conversation = id as ConversationId;
			const live = await harness.snapshot(LiveDoc, conversation, ctx);
			if (live?.run !== undefined) continue;
			const inbox = await harness.snapshot(InboxDoc, conversation, ctx);
			if (!inbox?.items.some((item) => item.mode !== "write")) continue;
			await (await harness.conversation(conversation, ctx))?.submit({ type: "write", entry: { kind: "stomp.nudge", data: {} } }, ctx);
		}
	};
	let timer: NodeJS.Timeout | undefined;
	const soon = () => {
		timer ??= setTimeout(() => {
			timer = undefined;
			check().catch((error: unknown) => console.error("[stomp] inbox", error));
		}, 200);
	};
	soon();
	const unsubscribe = harness.subscribeCommits(({ changes }) => {
		if (changes.some((c) => c.type === "task" && c.value.kind === GENERATION)) soon();
	});
	return () => {
		clearTimeout(timer);
		unsubscribe();
	};
}
