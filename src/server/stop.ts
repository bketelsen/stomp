// Stopping a thread: its Delegations, its Reviews, then its run. Brian's Abort and the supervisor's cancel mean the
// same thing, so a review can't wake an agent that was just stopped. Its current commit counts as review declined,
// so only a new commit starts another review. The thread stays open for input.
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { DELEGATION } from "./delegation.ts";
import { REVIEW } from "./review.ts";
import { ThreadsDoc } from "./threads.ts";
import { git } from "./workspace.ts";

/** Returns how many live Delegations it stopped. */
export async function stopThread(harness: Harness, thread: number, c: Context): Promise<number> {
	const live = (await harness.inspect(c)).tasks
		.map((task) => task.record)
		.filter((task) => (task.kind === DELEGATION || task.kind === REVIEW) && (task.input as { thread?: number }).thread === thread);
	for (const task of live) await harness.abortTask(task.id, c);
	await (await harness.conversation(thread as ConversationId, c))?.abort(c);
	for (const task of live) await harness.waitForTask(task.id, c);
	const worktree = (await harness.snapshot(ThreadsDoc, c))?.threads[thread]?.worktree;
	if (worktree !== undefined) {
		const head = (await git(worktree, "rev-parse", "HEAD")).trim();
		await harness.commit(async (tx) => {
			const row = (await tx.doc(ThreadsDoc)).threads[thread];
			if (row !== undefined) row.requested = head;
		}, c);
	}
	return live.filter((task) => task.kind === DELEGATION).length;
}
