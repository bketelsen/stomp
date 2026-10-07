// Cross-family review (docs/plan.md "Cross-family review"). A thread bound to a worktree gets a Review task whenever it's
// idle with a HEAD nobody reviewed or tried to: a reviewer from another family gives a typed verdict, blocking findings
// go back to the author for at most `rounds` fix rounds, and the result lands in the thread's row and as a card in its
// transcript. Checkpoints and request ids make every phase restart-safe; there is no recovery code.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	GenerationTask,
	type Harness,
	type HookRegistration,
	LiveDoc,
	type ModelRef,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { REVIEW_ENTRY } from "../shared/protocol.ts";
import type { AgentConfig } from "./agents.ts";
import { bashWithTimeout } from "./coding.ts";
import type { StompConfig } from "./config.ts";
import { linksOf } from "./models.ts";
import { readFileTool } from "./readonly.ts";
import { type Binding, type ThreadRecord, ThreadsDoc } from "./threads.ts";
import { git } from "./workspace.ts";

export const REVIEW = "stomp.review";
const GENERATION = GenerationTask.definition.name;
const DIFF_CAP = 60_000;
const LIVE = ["pending", "running", "waiting", "completing"] as const;

const Finding = Type.Object({
	severity: Type.Union([Type.Literal("blocking"), Type.Literal("note")]),
	file: Type.Optional(Type.String()),
	line: Type.Optional(Type.Integer()),
	summary: Type.String({ description: "For a blocking finding, the concrete failure: what happens, and when" }),
});
const Verdict = Type.Object({
	verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested")]),
	findings: Type.Array(Finding),
});
type Verdict = Static<typeof Verdict>;

const verdictTool = defineTool({
	name: "verdict",
	description: "Record your review. Call it once, when you're done.",
	parameters: Verdict,
	replay: "safe",
	// `terminate` ends the reviewer's run on this call; the task reads the verdict from the result's details.
	execute: async (args) => ({ content: [{ type: "text", text: "Recorded." }], details: args, control: { terminate: true } }),
});

const REVIEWER = `You review a change another agent committed in this git worktree. Don't edit files, commit or push.
Read the code and run its tests with read_file and bash when that helps.
A finding is blocking only when it is one of these:
- the change doesn't do what the brief asked;
- a bug the user would hit in normal use;
- data loss;
- a security problem or an exposed credential.
Everything else is a note: style, naming, refactors, missing tests for unlikely paths, and hypothetical races or edge
cases without a concrete failure in normal use. Each blocking finding states the concrete failure: what happens, when.
Don't ask for work beyond the brief. Approving with notes is normal and expected.
Finish by calling verdict once.`;
const NUDGE = "You haven't called verdict. Call it now with your verdict and findings.";
/** Fix requests start with this, so a later review's brief skips them. */
const FIX_PREFIX = "[review by ";

/** The row's review: protocol.ts's ReviewRecord as a plain type a doc and an entry can hold. */
type Result = NonNullable<ThreadRecord["review"]>;
export type PoolModel = { ref: ModelRef; family: string };
export type ReviewOptions = {
	pool: readonly PoolModel[];
	rounds: number;
	repos: StompConfig["repos"];
	bashTimeoutSeconds: number;
	/** The guard: reviewers' commands (and reads of stomp's own files) are judged, and their asks reach Brian, like an agent's. */
	guard: HookRegistration;
	familyOf(modelId: string): string | undefined;
	/** Late-bound: tasks can't make write submissions, so the card goes in through the host's Harness. */
	harness(): Harness;
};

/** review.pool, resolved like agent models; an entry that doesn't resolve is skipped with a line in the log. */
export function reviewPool(
	specs: readonly string[],
	resolve: (spec: string) => ModelRef | string,
	familyOf: (modelId: string) => string | undefined,
): PoolModel[] {
	return specs.flatMap((spec) => {
		const ref = resolve(spec);
		const family = typeof ref === "string" ? undefined : familyOf(ref.modelId);
		if (typeof ref !== "string" && family !== undefined) return [{ ref, family }];
		console.error(`[stomp] review.pool: skipping ${spec}: ${typeof ref === "string" ? ref : "unknown family"}`);
		return [];
	});
}

/** Startup check: every agent has a reviewer from another family. */
export function checkPool(pool: readonly PoolModel[], agents: readonly AgentConfig[]): void {
	for (const agent of agents) {
		if (agent.role !== "agent" || agent.error !== undefined || pool.some((m) => !agent.families.includes(m.family))) continue;
		throw new Error(`review.pool in stomp.yaml has no model outside the ${agent.families.join(" and ")} family to review ${agent.id}`);
	}
}

const short = (sha: string) => sha.slice(0, 8);
const head = (worktree: string) => git(worktree, "rev-parse", "HEAD");
const tag = (name: string, text: string) => `<${name}>\n${text}\n</${name}>`;
const blockers = (r: Result) => r.findings.filter((f) => f.severity === "blocking");
const textOf = (m: Message | undefined): string =>
	m === undefined || m.role === "toolResult" || m.role === "system"
		? ""
		: typeof m.content === "string"
			? m.content
			: m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

/** A thread that has commits nobody reviewed or tried to review. */
const unreviewed = (row: ThreadRecord, sha: string) => sha !== row.base && sha !== row.review?.sha && sha !== row.requested;

/** The Delegation's brief (a delegated thread's first message), else the latest request before the commits. */
function briefOf(row: ThreadRecord, messages: readonly Message[]): string {
	const asks = messages.filter((m) => m.role === "user").map(textOf).filter((text) => !text.startsWith(FIX_PREFIX));
	return ((row.delegatedBy === undefined ? asks.at(-1) : asks[0]) ?? "(none)").slice(0, 8000);
}

async function diffOf(row: Binding, sha: string): Promise<string> {
	const diff = await git(row.worktree, "diff", `${row.base}...${sha}`);
	if (diff.length <= DIFF_CAP) return diff;
	return `${diff.slice(0, DIFF_CAP)}\n[cut at ${DIFF_CAP} of ${diff.length} characters; run git diff ${short(row.base)}...${short(sha)}]`;
}

const where = (f: Result["findings"][number]) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : "");

/** How a Delegation's report ends: one Review line, then the notes, so the supervisor can relay them. */
export function reviewLine(r: Result): string {
	if (r.verdict === "failed") return "Review: failed (no verdict)";
	const by = `${r.reviewer} (${r.family})${r.rounds > 1 ? ` after ${r.rounds} rounds` : ""}`;
	const open = blockers(r);
	const notes = r.findings.filter((f) => f.severity !== "blocking");
	const noted = notes.length ? `, ${notes.length} note${notes.length > 1 ? "s" : ""}` : "";
	const line =
		r.verdict === "approved"
			? `Review: approved by ${by}${noted}`
			: `Review: changes requested by ${by} — ${open.length} blocking finding${open.length > 1 ? "s" : ""} open: ${open.map((f) => f.summary).join("; ")}${noted}`;
	return [line, ...notes.map((f) => `- note: ${where(f)}${f.summary.slice(0, 300)}`)].join("\n");
}

type ReviewInput = { thread: number; sha: string };
type Round = { sha: string; round: number; reviewer?: number; model?: string; family?: string };
type ReviewState = ({ phase: "review" } & Round) | ({ phase: "fix"; result: Result } & Round) | { phase: "done"; result: Result };
type Runtime = TaskRuntime<ReviewInput, ReviewState, null, object>;
/** What a Delegation's runtime offers reviewed(). */
type Waiter = Pick<Runtime, "conversation" | "snapshot" | "waitForTask"> & {
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<void>;
};

const next = (checkpoint: ReviewState) => ({ status: "running", checkpoint }) as const;

async function boundRow(rt: Pick<Runtime, "snapshot">, thread: number, c: Context): Promise<ThreadRecord & Binding> {
	const row = (await rt.snapshot(ThreadsDoc, c))?.threads[thread];
	if (row?.worktree === undefined) throw new Error(`thread ${thread} has no worktree`);
	return row as ThreadRecord & Binding;
}

/** The newest successful verdict after entry `since` in the reviewer's transcript. */
async function verdictOf(rt: Runtime, reviewer: ConversationId, since: number, c: Context): Promise<Verdict | undefined> {
	for (const entry of (await rt.context(reviewer, c)).entries.toReversed()) {
		if (entry.id <= since) return undefined;
		const m = entry.model?.[0];
		if (m?.role === "toolResult" && m.toolName === "verdict" && !m.isError) return m.details as Verdict;
	}
	return undefined;
}

export function stompReview(options: ReviewOptions) {
	const Review = defineTask<ReviewInput, ReviewState, null>({
		name: REVIEW,
		version: 1,
		initial: ({ sha }) => ({ phase: "review", sha, round: 1 }),
		phases: {
			review: async (task, rt, c) => {
				const thread = task.input.thread as ConversationId;
				const row = await boundRow(rt, thread, c);
				let cp = task.state.checkpoint;
				if (cp.reviewer === undefined) {
					// Any link of a fallback model may have written the commits.
					const model = (await rt.agent(c)).model;
					const authors = model ? linksOf(model).map((link) => options.familyOf(link.modelId)) : [];
					const pick = options.pool.find((m) => !authors.includes(m.family));
					if (pick === undefined) throw new Error(`review.pool has no model outside the ${authors.join(" and ")} family`);
					const seed = cp;
					await rt.commit(async (tx) => {
						const { id } = await tx.createConversation({ ownership: { kind: "task", taskId: rt.taskId } });
						// A task-owned conversation starts as a copy of the author's agent: set model, tools, prompt and cwd.
						await configure(tx, id, { model: pick.ref, extensions: [extension], instructions: REVIEWER, cwd: row.worktree });
						cp = { ...seed, reviewer: id, model: `${pick.ref.provider}/${pick.ref.modelId}`, family: pick.family };
						return next(cp);
					}, c);
				}
				const reviewer = (await rt.conversation(cp.reviewer as ConversationId, c))!;
				const { messages } = await rt.context(thread, c);
				const test = options.repos[row.repo]?.test;
				const prompt = [
					cp.round === 1
						? `Review the commits on ${row.branch} in ${row.worktree}, ${short(row.base)}..${short(cp.sha)}.\n\n${tag("brief", briefOf(row, messages))}`
						: `The author answered your blocking findings. Review the change again at ${short(cp.sha)}.`,
					tag("author-says", textOf(messages.findLast((m) => m.role === "assistant" && textOf(m) !== "")).slice(0, 8000)),
					...(test ? [`The repo's tests run with: ${test}`] : []),
					tag("diff", await diffOf(row, cp.sha)),
				];
				const ask = async (content: string, requestId: string) =>
					(await reviewer.submit({ type: "input", content, requestId }, c)).wait(c);
				const since = (await ask(prompt.join("\n\n"), `review:${cp.sha}`)).entry ?? 0;
				let verdict = await verdictOf(rt, reviewer.id, since, c);
				if (verdict === undefined) {
					await ask(NUDGE, `nudge:${cp.sha}`);
					verdict = await verdictOf(rt, reviewer.id, since, c);
				}
				const findings = verdict?.findings ?? [];
				const blocking = findings.some((f) => f.severity === "blocking");
				const result: Result = {
					sha: cp.sha,
					// Blocking findings decide, whatever the reviewer called its verdict.
					verdict: verdict === undefined ? "failed" : blocking ? "changes_requested" : "approved",
					findings,
					reviewer: cp.model!,
					family: cp.family!,
					rounds: cp.round,
				};
				const fix = blocking && cp.round <= options.rounds;
				await rt.commit(() => next(fix ? { ...cp, phase: "fix", result } : { phase: "done", result }), c);
			},
			fix: async (task, rt, c) => {
				const thread = task.input.thread as ConversationId;
				const { result, ...round } = task.state.checkpoint;
				const row = await boundRow(rt, thread, c);
				const where = (f: Result["findings"][number]) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : "");
				const content = [
					`${FIX_PREFIX}${result.reviewer} (${result.family})] Blocking findings on ${short(round.sha)}:`,
					...blockers(result).map((f) => `- ${where(f)}${f.summary}`),
					"",
					"Fix them and commit, or say why they're wrong.",
				].join("\n");
				const author = (await rt.conversation(thread, c))!;
				const request = { type: "input", content, whenBusy: "followUp", requestId: `fix:${rt.taskId}:${round.sha}` } as const;
				await (await author.submit(request, c)).wait(c);
				const sha = await head(row.worktree);
				await rt.commit(
					() => next(sha !== round.sha ? { ...round, phase: "review", sha, round: round.round + 1 } : { phase: "done", result }),
					c,
				);
			},
			done: async (task, rt, c) => {
				const thread = task.input.thread as ConversationId;
				const { result } = task.state.checkpoint;
				// A write submission adds the card without a turn and without anything in model context.
				const conversation = (await options.harness().conversation(thread, c))!;
				await conversation.submit({ type: "write", entry: { kind: REVIEW_ENTRY, data: result }, requestId: `card:${rt.taskId}` }, c);
				await rt.commit(async (tx) => {
					const row = (await tx.doc(ThreadsDoc)).threads[thread];
					if (row !== undefined) row.review = result;
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, c);
			},
		},
		abort: (_task, rt, c) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c),
	});
	// The reviewer's tools, and the task. Authors select stomp-coding only, so they never see `verdict`.
	const extension = defineExtension({
		name: "stomp-review",
		tools: [readFileTool(), bashWithTimeout(options.bashTimeoutSeconds), verdictTool],
		hooks: [options.guard],
		tasks: [Review],
	}) as Extension;

	/** Inside a commit: the thread's live Review, or a new one for `sha` if nobody reviewed or tried to review it. */
	async function ensure(tx: Tx, thread: ConversationId, sha: string): Promise<TaskId | undefined> {
		for (const status of LIVE) {
			const [live] = (await tx.scanTasks({ conversationId: thread, kind: REVIEW, status }, 1)).items;
			if (live !== undefined) return live.id;
		}
		const row = (await tx.doc(ThreadsDoc)).threads[thread];
		if (row?.worktree === undefined || !unreviewed(row, sha)) return undefined;
		row.requested = sha;
		return tx.createTask(Review, { thread, sha }, { ownership: { kind: "conversation" }, conversationId: thread, background: true });
	}

	/**
	 * Level-triggered, on generation and Review task changes and at startup: each bound thread that's idle with
	 * unreviewed commits gets a Review. Requesting in the creating commit allows one attempt per HEAD.
	 */
	function start(harness: Harness): () => void {
		const check = async () => {
			for (const [key, row] of Object.entries((await harness.snapshot(ThreadsDoc, ctx))?.threads ?? {})) {
				const thread = Number(key) as ConversationId;
				if (row.worktree === undefined || (await harness.snapshot(LiveDoc, thread, ctx))?.run !== undefined) continue;
				const sha = await head(row.worktree).catch(() => undefined);
				if (sha === undefined || !unreviewed(row, sha)) continue;
				await harness.commit(async (tx) => {
					if ((await tx.doc(LiveDoc, thread)).run === undefined) await ensure(tx, thread, sha);
				}, ctx);
			}
		};
		let timer: NodeJS.Timeout | undefined;
		const soon = () => {
			timer ??= setTimeout(() => {
				timer = undefined;
				check().catch((error: unknown) => console.error("[stomp] review", error));
			}, 200);
		};
		soon();
		const unsubscribe = harness.subscribeCommits(({ changes }) => {
			if (changes.some((c) => c.type === "task" && (c.value.kind === REVIEW || c.value.kind === GENERATION))) soon();
		});
		return () => {
			clearTimeout(timer);
			unsubscribe();
		};
	}

	/**
	 * For a Delegation, once its thread is idle: the review line for the thread's HEAD, waiting for its Review (and
	 * starting it, if the trigger hasn't yet). Undefined when the thread is unbound or has no commits.
	 */
	async function reviewed(rt: Waiter, thread: ConversationId, c: Context): Promise<string | undefined> {
		for (;;) {
			await (await rt.conversation(thread, c))!.waitForIdle(c);
			const row = (await rt.snapshot(ThreadsDoc, c))?.threads[thread];
			const sha = row?.worktree === undefined ? undefined : await head(row.worktree);
			if (sha === undefined || sha === row?.base) return undefined;
			let live: TaskId | undefined;
			await rt.commit(async (tx) => {
				live = await ensure(tx, thread, sha);
				return undefined;
			}, c);
			if (live === undefined) {
				const review = (await rt.snapshot(ThreadsDoc, c))?.threads[thread]?.review;
				return review?.sha === sha ? reviewLine(review) : undefined;
			}
			await rt.waitForTask(live, c);
		}
	}

	return { extension, start, reviewed };
}
