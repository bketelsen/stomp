import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { REPORT_PREFIX, REVIEW_ENTRY } from "../src/shared/protocol.ts";
import { REVIEW } from "../src/server/review.ts";
import { startStomp } from "../src/server/stomp.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { type Request, scriptedModels, type Turn } from "./support/scripted.ts";

const commit = (edit: string, message: string) => `${edit} && git add -A && git commit -qm '${message}'`;
const BUG = commit(`printf 'export const add = (a, b) => a - b;\\n' > add.js`, "Add add()");
const FIX = commit("sed -i 's/a - b/a + b/' add.js", "Fix add()");
const AGAIN = commit("echo again >> always-blocks.txt", "Try again");
const BLOCKER = { severity: "blocking", file: "add.js", line: 1, summary: "add() subtracts: add(2, 2) returns 0" };
const NOTE = { severity: "note", summary: "no test for add()" };
const NIT = { severity: "note", summary: "name it sum" };

/** The author runs the command after "run: " (binding first when told to), and fixes what the reviewer names. */
function author(r: Request, repo: string): Turn {
	const said = r.lastUserText;
	const fix = said.startsWith("[review by");
	if (said.startsWith("bind") && r.lastTool === undefined) return { calls: [["workspace", { repo }]] };
	const command = fix ? (said.includes("subtracts") ? FIX : AGAIN) : /run: (.*)/.exec(said)?.[1];
	if (command && r.lastTool !== "bash") return { bash: command };
	return { text: fix ? "Fixed it." : `done: ${said.slice(0, 20)}` };
}

/** The reviewer decides from the diff: a - b blocks, always-blocks always blocks, nits are notes, no-verdict never calls it. */
function reviewer(r: Request): Turn {
	const said = r.lastUserText;
	const verdict = (v: string, findings: JsonObject[]): Turn => ({ calls: [["verdict", { verdict: v, findings }]] });
	if (said.includes("no-verdict") || said.startsWith("You haven't")) return { text: "Looks fine." };
	if (said.includes("ask-reviewer") && r.lastTool === undefined) return { bash: "echo reviewer-ran | sh" };
	if (said.includes("a - b")) return verdict("changes_requested", [BLOCKER, NOTE]);
	if (said.includes("always-blocks")) return verdict("changes_requested", [{ severity: "blocking", summary: "always-blocks is there" }]);
	if (said.includes("nits")) return verdict("changes_requested", [NOTE, NIT]);
	return verdict("approved", [NOTE]);
}

function gitRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	for (const [key, value] of [["user.name", "stomp test"], ["user.email", "test@stomp.invalid"], ["commit.gpgsign", "false"]]) git("config", key!, value!);
	writeFileSync(join(dir, "README.md"), "# toy\n");
	git("add", "-A");
	git("commit", "-qm", "base");
	return dir;
}

/** A supervisor, a Claude-family author and a review pool whose first entry is Claude, so the author gets GPT. */
async function startReviewed(t: TestContext, pool = "[scripted/claude-r, scripted/gpt-r]") {
	const fx = fixture();
	const repo = gitRepo(join(fx.root, "repo"));
	const yaml = `families: { '^w[0-9]': test }\nreview: { pool: ${pool}, rounds: 2 }\nrepos: { '${repo}': { test: 'node --test' } }\n`;
	writeFileSync(join(fx.configDir, "stomp.yaml"), yaml);
	fx.agent("boss", agentFile("Boss", "scripted/w0", "role: supervisor\n"));
	fx.agent("alpha", agentFile("Alpha", "scripted/claude-a"));
	const reviewers: Request[] = [];
	const models = scriptedModels(
		(r) => {
			if (r.model === "claude-a") return author(r, repo);
			if (r.model === "w0") {
				if (r.toolResults || !r.lastUserText.startsWith("delegate ")) return { text: "ok" };
				return { calls: [["delegate", { agent: "alpha", brief: r.lastUserText.slice(9), repo }]] };
			}
			reviewers.push(r);
			return { ...reviewer(r), delayMs: r.lastUserText.includes("slow") ? 1500 : 100 };
		},
		["w0", "claude-a", "claude-r", "gpt-r"],
	);
	const open = () => startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models });
	let stomp = await open().catch((error: unknown) => {
		fx.cleanup();
		throw error;
	});
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const conversation = async (id: number) => (await stomp.harness.conversation(id as ConversationId, ctx))!;
	const entries = async (id: number) => (await (await conversation(id)).entries({}, 500, undefined, ctx)).items.toReversed();
	const userTexts = async (id: number) =>
		(await entries(id)).flatMap((e) => e.model ?? []).flatMap((m) => (m.role === "user" && typeof m.content === "string" ? [m.content] : []));
	const s = {
		repo,
		reviewers,
		desk: async (agent: string) => (await stomp.state()).agents.find((a) => a.id === agent)!.deskThread,
		thread: async (id: number) => (await stomp.state()).threads.find((thread) => thread.id === id)!,
		say: async (id: number, text: string) => (await (await conversation(id)).submit({ type: "input", content: text }, ctx)).wait(ctx),
		head: (worktree: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(),
		tasks: () => stomp.harness.commit(async (tx) => (await tx.scanTasks({ kind: REVIEW }, 100)).items, ctx),
		/** Wait until the thread has a review and is idle, noting every status on the way. */
		async settled(id: number, seen = new Set<string>()) {
			return until(async () => {
				const thread = await s.thread(id);
				seen.add(thread.status);
				return thread.review && thread.status === "idle" && (await s.tasks()).every((task) => task.state.status === "terminal") && thread;
			}, 20_000);
		},
		/** Review prompts per reviewer conversation, fix requests and cards in the thread. */
		async counts(id: number) {
			const tasks = await s.tasks();
			const owned = await stomp.harness.commit(async (tx) => (await tx.scanConversations({ ownerTaskId: tasks[0]!.id }, 10)).items, ctx);
			const prompts = await Promise.all(owned.map(async (c) => (await userTexts(c.id)).length));
			const fixes = (await userTexts(id)).filter((text) => text.startsWith("[review by")).length;
			const cards = (await entries(id)).filter((e) => e.kind === REVIEW_ENTRY);
			return { tasks: tasks.length, prompts, fixes, cards };
		},
		userTexts,
		conversation,
		abort: (id: number) => fetch(`${stomp.url}/api/threads/${id}/abort`, { method: "POST" }),
		ask: () => until(async () => (await stomp.state()).asks[0]),
		answer: (id: string, body: unknown) => fetch(`${stomp.url}/api/asks/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }),
		async restart() {
			await stomp.close();
			stomp = await open();
		},
	};
	return s;
}

test("a GPT reviewer blocks a Claude author's commit, the fix goes back, and round 2 approves", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `bind; run: ${BUG}`);
	const seen = new Set<string>();
	const thread = await s.settled(desk, seen);
	assert.ok(seen.has("reviewing"), [...seen].join());
	const worktree = join(s.repo, "..", "state", "work", `alpha-${desk}`);
	assert.deepEqual([thread.repo, thread.branch], [s.repo, `stomp/alpha/${desk}`]);
	assert.deepEqual(thread.review, { sha: s.head(worktree), verdict: "approved", findings: [NOTE], reviewer: "scripted/gpt-r", family: "openai", rounds: 2 });
	const counts = await s.counts(desk);
	assert.deepEqual([counts.tasks, counts.prompts, counts.fixes], [1, [2], 1]);
	assert.deepEqual(counts.cards.map((card) => card.data), [thread.review]);
	const view = await (await s.conversation(desk)).context(ctx);
	assert.deepEqual(view.contributions[view.entries.findIndex((e) => e.kind === REVIEW_ENTRY)], [], "the card adds nothing to model context");
	const [fix] = (await s.userTexts(desk)).filter((text) => text.startsWith("[review by"));
	assert.match(fix!, /^\[review by scripted\/gpt-r \(openai\)\] Blocking findings on [0-9a-f]{8}:\n- add\.js:1: add\(\) subtracts: add\(2, 2\) returns 0\n\nFix them/);
	assert.doesNotMatch(fix!, /no test for add/, "notes don't go to the author");
	const first = s.reviewers[0]!;
	assert.deepEqual([first.model, first.tools], ["gpt-r", ["read_file", "bash", "verdict"]]);
	assert.match(first.system, /A finding is blocking only when/);
	assert.match(first.lastUserText, new RegExp(`in ${worktree}, [0-9a-f]{8}\\.\\.[0-9a-f]{8}\\.\\n\\n<brief>\\nbind; run: printf`));
	assert.match(first.lastUserText, /The repo's tests run with: node --test\n\n<diff>\ndiff --git a\/add\.js/);
	// A turn without a new commit starts no review.
	await s.say(desk, "hello");
	await sleep(500);
	assert.equal((await s.tasks()).length, 1);
});

test("still blocking after the configured rounds: done with the finding open, and the thread carries on", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `bind; run: ${AGAIN}`);
	const thread = await s.settled(desk);
	assert.equal(thread.review!.verdict, "changes_requested");
	assert.deepEqual([thread.review!.rounds, thread.review!.findings.map((f) => f.severity)], [3, ["blocking"]]);
	const counts = await s.counts(desk);
	assert.deepEqual([counts.tasks, counts.prompts, counts.fixes, counts.cards.length], [1, [3], 2, 1]);
	await s.say(desk, "hello");
	await sleep(500);
	assert.equal((await s.tasks()).length, 1);
});

test("no verdict gets one nudge, then the review is recorded as failed", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `bind; run: ${commit("touch no-verdict.txt", "x")}`);
	const thread = await s.settled(desk);
	assert.deepEqual([thread.review!.verdict, thread.review!.findings, thread.review!.rounds], ["failed", [], 1]);
	const counts = await s.counts(desk);
	assert.deepEqual([counts.prompts, counts.fixes, counts.cards.length], [[2], 0, 1]);
});

test("changes_requested with only notes counts as approved, and nothing goes back to the author", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `bind; run: ${commit("touch nits.txt", "x")}`);
	const thread = await s.settled(desk);
	assert.deepEqual([thread.review!.verdict, thread.review!.findings, thread.review!.rounds], ["approved", [NOTE, NIT], 1]);
	assert.equal((await s.counts(desk)).fixes, 0);
});

test("uncommitted changes and turns without a commit start no review", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, "bind; run: echo wip > wip.txt");
	await s.say(desk, "hello");
	await s.restart();
	await sleep(600);
	assert.deepEqual(await s.tasks(), []);
	assert.equal((await s.thread(desk)).repo, s.repo);
});

test("a delegated thread with a repo starts in its worktree and is reviewed before it reports", async (t) => {
	const s = await startReviewed(t);
	const boss = await s.desk("boss");
	await s.say(boss, `delegate run: ${BUG}`);
	const report = await until(async () => (await s.userTexts(boss)).find((text) => REPORT_PREFIX.test(text)), 20_000);
	const id = Number(REPORT_PREFIX.exec(report)![2]);
	// The author's reply to the fix round reaches the report, before the Review line and its notes.
	assert.match(report, /done: run: printf 'export\n\nFixed it\.\n\nReview: approved by scripted\/gpt-r \(openai\) after 2 rounds, 1 note\n- note: /);
	const info = await s.thread(id);
	assert.deepEqual([info.branch, info.review!.verdict, info.delegation], [`stomp/alpha/${id}`, "approved", "reported"]);
	assert.deepEqual((await s.counts(id)).prompts, [2]);
});

test("a restart during the review phase: one review, one fix, one card", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `bind; run: ${BUG.replace("Add add()", "slow")}`);
	await until(() => s.reviewers.length > 0);
	await s.restart();
	const thread = await s.settled(desk);
	assert.deepEqual([thread.review!.verdict, thread.review!.rounds], ["approved", 2]);
	const counts = await s.counts(desk);
	assert.deepEqual([counts.tasks, counts.prompts, counts.fixes, counts.cards.length], [1, [2], 1, 1]);
	assert.equal(s.reviewers.filter((r) => r.lastUserText.includes("slow")).length, 2, "the interrupted request ran again");
});

test("a reviewer's command asks on the thread it reviews, and Brian's answer reaches the reviewer", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `bind; run: ${commit("touch ask-reviewer.txt", "x")}`);
	const ask = await s.ask();
	const worktree = join(s.repo, "..", "state", "work", `alpha-${desk}`);
	assert.deepEqual([ask.agent, ask.thread, ask.cwd, ask.why], ["reviewer", desk, worktree, "rule: piped into a shell"]);
	assert.equal((await s.thread(desk)).status, "needs-you");
	assert.equal((await s.answer(ask.id, { decision: "deny", note: "read the diff" })).status, 200);
	assert.equal((await s.settled(desk)).review!.verdict, "approved");
});

test("a pool without a second family for some agent is a startup error naming it", async (t) => {
	await assert.rejects(startReviewed(t, "[scripted/claude-r]"), /no model outside the anthropic family to review alpha/);
});

// Found by the phase 3 cross-family review: a stopped thread must not be woken by its review's fix round.
test("Abort during a review stops the review, so no fix request wakes the author", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `bind slow; run: ${BUG}`);
	await until(async () => (await s.thread(desk)).status === "reviewing", 10_000);
	assert.equal((await s.abort(desk)).status, 200);
	await sleep(2500);
	assert.equal((await s.userTexts(desk)).filter((text) => text.startsWith("[review by")).length, 0);
	assert.ok((await s.tasks()).every((task) => task.state.status === "terminal"));
	assert.equal((await s.thread(desk)).status, "idle");
});

test("Abort after a fix commit doesn't start a new review of that commit", async (t) => {
	const s = await startReviewed(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `bind slow; run: ${AGAIN}`);
	const fixes = async () => (await s.userTexts(desk)).filter((text) => text.startsWith("[review by")).length;
	// Round 1 blocks, the author commits again, and round 2 starts on the new commit.
	await until(async () => (await fixes()) === 1 && (await s.thread(desk)).status === "reviewing", 15_000);
	assert.equal((await s.abort(desk)).status, 200);
	const reviews = (await s.tasks()).length;
	await sleep(3000);
	assert.deepEqual([await fixes(), (await s.tasks()).length], [1, reviews]);
});
