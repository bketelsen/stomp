import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { REPORT_PREFIX } from "../src/shared/protocol.ts";
import { startStomp } from "../src/server/stomp.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { scriptedModels } from "./support/scripted.ts";

const MINUTE = 60_000;
const textOf = (m: Message) => (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join(""));

/** Alpha, working in a temp dir, with one duty; a supervisor unless `boss` is false. The duty clock moves only when told. Told "call: <tool> <json>", the supervisor calls it. */
async function startDuty(t: TestContext, duty: string, boss = true) {
	const fx = fixture();
	const cwd = join(fx.root, "alpha");
	mkdirSync(cwd);
	if (boss) fx.agent("boss", agentFile("Boss", "scripted/w0", "role: supervisor\n"));
	fx.agent("alpha", agentFile("Alpha", "scripted/w1", `cwd: ${cwd}\nduties:\n  - ${duty}\n`));
	const systems: Record<string, string> = {};
	const models = scriptedModels((r) => {
		systems[r.model] = r.system;
		const call = r.model === "w0" && r.lastTool === undefined && /^call: (\w+) (.*)/.exec(r.lastUserText);
		return call ? { calls: [[call[1]!, JSON.parse(call[2]!)]] } : { text: r.model === "w0" ? "ack" : `w1 did ${r.lastUserText}` };
	}, ["w0", "w1"]);
	let now = Date.UTC(2026, 9, 6, 12);
	const open = () =>
		startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models, dutyClock: { tickMs: 20, now: () => now } });
	let stomp = await open();
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const texts = async (id: number, role: Message["role"]) =>
		(await (await stomp.harness.conversation(id as ConversationId, ctx))!.entries({}, 100, undefined, ctx)).items
			.toReversed()
			.flatMap((e) => e.model ?? [])
			.flatMap((m) => (m.role === role ? [textOf(m)] : []));
	const d = {
		start: now,
		fx,
		cwd,
		systems,
		say: async (thread: number, text: string) =>
			(await (await stomp.harness.conversation(thread as ConversationId, ctx))!.submit({ type: "input", content: text }, ctx)).wait(ctx),
		ask: () => until(async () => (await stomp.state()).asks[0]),
		answer: async (id: string, body: unknown) => (await fetch(`${stomp.url}/api/asks/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) })).status,
		duties: async () => (await stomp.state()).agents.find((a) => a.id === "alpha")!.duties,
		write: (file: string, text: string) => writeFileSync(join(cwd, file), text),
		duty: async () => (await stomp.state()).agents.find((a) => a.id === "alpha")!.duties[0]!,
		desk: async (agent: string) => (await stomp.state()).agents.find((a) => a.id === agent)!.deskThread,
		woken: async () => (await stomp.state()).threads.filter((thread) => thread.title.startsWith("duty: ")),
		/** Move the clock and wait for the run it makes due, or a few ticks when it makes none. */
		async advance(ms: number, due = true) {
			now += ms;
			await (due ? until(async () => (await d.duty()).lastRun === now) : sleep(200));
		},
		texts,
		reports: async () => (await texts(await d.desk("boss"), "user")).filter((text) => REPORT_PREFIX.test(text)),
		async restart() {
			await stomp.close();
			stomp = await open();
		},
	};
	return d;
}

test("a changed duty records a baseline, stays quiet while the output holds, and wakes once through the supervisor when it changes", async (t) => {
	const d = await startDuty(t, "{ name: disk, every: 5m, check: cat df.txt, brief: Free some space. }");
	d.write("df.txt", "disk 40%\n");
	await d.advance(0);
	assert.deepEqual(await d.duty(), { name: "disk", every: "5m", lastRun: d.start, lastExit: 0, next: d.start + 5 * MINUTE });
	await d.advance(4 * MINUTE, false);
	assert.equal((await d.duty()).lastRun, d.start, "not due before every has passed");
	await d.advance(MINUTE);
	assert.deepEqual(await d.woken(), []);

	d.write("df.txt", "disk 97%\n");
	await d.advance(5 * MINUTE);
	const [thread] = await until(() => d.woken().then((w) => w.length > 0 && w));
	const boss = await d.desk("boss");
	assert.deepEqual([thread!.agent, thread!.title, thread!.delegatedBy], ["alpha", "duty: disk", boss]);
	assert.equal((await d.duty()).lastWoke, d.start + 10 * MINUTE);
	// The wake shows before and now: found in the first real run, where Teg couldn't tell what had changed.
	const brief = "[duty disk] Free some space.\n\nThe check ran `cat df.txt` (exit 0):\ndisk 97%\n\nThe last run (exit 0) printed:\ndisk 40%";
	assert.deepEqual(await d.texts(thread!.id, "user"), [brief]);
	await until(async () => (await d.reports()).length > 0);
	assert.deepEqual(await d.reports(), [`[report from Alpha, thread ${thread!.id}] w1 did ${brief}`]);

	await d.advance(5 * MINUTE);
	assert.equal((await d.woken()).length, 1, "the same output again doesn't wake");
});

test("a failed duty wakes on each failing run, and a restart doesn't wake it twice", async (t) => {
	const d = await startDuty(t, `{ name: ci, every: 1h, check: 'cat ci.txt; grep -q ok ci.txt', wake: failed, brief: Fix CI. }`);
	d.write("ci.txt", "red\n");
	await d.advance(0);
	await until(async () => (await d.reports()).length > 0);
	await d.restart();
	await d.advance(0, false);
	assert.equal((await d.woken()).length, 1);
	assert.equal((await d.reports()).length, 1);

	await d.advance(60 * MINUTE);
	await until(async () => (await d.woken()).length === 2);
	d.write("ci.txt", "ok\n");
	await d.advance(60 * MINUTE);
	assert.deepEqual([(await d.woken()).length, (await d.duty()).lastExit], [2, 0]);
	assert.match((await d.texts((await d.woken())[1]!.id, "user"))[0]!, /^\[duty ci\] Fix CI\.\n\nThe check ran `cat ci\.txt; grep -q ok ci\.txt` \(exit 1\):\nred\n\nThe last run \(exit 1\) printed:\nred$/);
});

test("without a supervisor, a duty wakes the agent's desk, once across a restart; its check gets the agents' environment", async (t) => {
	process.env.TYPESAFE_API_KEY = "not-for-agents";
	t.after(() => delete process.env.TYPESAFE_API_KEY);
	const d = await startDuty(t, "{ name: ping, every: 15m, check: 'echo pong ${TYPESAFE_API_KEY:-hidden}', wake: always, brief: Say hi. }", false);
	await d.advance(0);
	const desk = await d.desk("alpha");
	await until(async () => (await d.texts(desk, "assistant")).length > 0);
	await d.restart();
	await d.advance(0, false);
	assert.deepEqual(await d.texts(desk, "user"), ["[duty ping] Say hi.\n\nThe check ran `echo pong ${TYPESAFE_API_KEY:-hidden}` (exit 0):\npong hidden"]);
	assert.deepEqual(await d.woken(), []);
});

// Found by the phase 5 review: a changed duty that fails from its first run used to become a silent baseline.
test("a changed duty that already fails on its first run wakes once, then only on change", async (t) => {
	const d = await startDuty(t, "{ name: probe, every: 5m, check: 'cat probe.txt; false', brief: Look. }");
	d.write("probe.txt", "down\n");
	await d.advance(0);
	await until(() => d.woken().then((w) => w.length === 1));
	await d.advance(5 * MINUTE);
	assert.equal((await d.woken()).length, 1, "the same failure again doesn't wake");
});

test("the supervisor sees every duty and adds, replaces and removes her own; a check she sets is judged as she sets it", async (t) => {
	const d = await startDuty(t, "{ name: disk, every: 5m, check: cat df.txt, brief: Free some space. }");
	const boss = await d.desk("boss");
	const call = (tool: string, args: object) => d.say(boss, `call: ${tool} ${JSON.stringify(args)}`);
	const result = async () => (await d.texts(boss, "toolResult")).at(-1)!;
	const yaml = () => (existsSync(join(d.fx.stateDir, "duties.yaml")) ? readFileSync(join(d.fx.stateDir, "duties.yaml"), "utf8") : "");
	await call("duty", { agent: "alpha", name: "disk", every: "1h", brief: "Mine now." });
	assert.equal(await result(), "alpha.md has a duty named disk; it's Brian's to change.");
	assert.match(d.systems.w0!, /- Alpha \(id: alpha, test\)\n {2}Duty disk, every 5m: runs `cat df\.txt`, wakes when its result changes\. Brief: Free some space\.\n/);

	// Without a check, a duty wakes every time, starting with its first run.
	await call("duty", { agent: "Alpha", name: "nightly", every: "1d", brief: "Check the backups." });
	assert.equal(await result(), "Added Alpha's duty: nightly, every 1d: wakes every time. Brief: Check the backups.");
	const thread = (await until(() => d.woken().then((w) => w.find((x) => x.title === "duty: nightly"))))!;
	assert.deepEqual(await d.texts(thread.id, "user"), ["[duty nightly] Check the backups."]);
	assert.equal(thread.delegatedBy, boss);
	assert.deepEqual((await d.duties()).map((x) => [x.name, x.added]), [["disk", undefined], ["nightly", true]]);
	assert.match(d.systems.w1!, /## Your duties\nstomp runs these .*\n- disk, every 5m: .*\n- nightly, every 1d: wakes every time\. Brief: Check the backups\.\n<\/instructions>/);
	await until(async () => (await d.reports()).length > 0);
	assert.match(d.systems.w0!, /Duty nightly, every 1d: wakes every time\. Brief: Check the backups\. \(you added it\)/);

	// Found by review: a check is judged where it will run, Alpha's checkout on main here, and a stray path doesn't turn
	// the ask into a file ask whose answer skips judging the check. Brian declines, and nothing is written.
	execFileSync("git", ["-C", d.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "init", "-q", "-b", "main"]);
	execFileSync("git", ["-C", d.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
	const push = { agent: "alpha", name: "nightly", every: "1d", check: "git push origin HEAD", brief: "Ship.", path: "/proc/self/environ" };
	const asking = call("duty", push);
	const ask = await d.ask();
	assert.deepEqual([ask.command, ask.why, ask.agent, ask.cwd], ["git push origin HEAD", "rule: push from main", "boss", d.cwd]);
	assert.equal(await d.answer(ask.id, { decision: "deny" }), 200);
	await asking;
	assert.match(await result(), /Brian declined/);
	assert.doesNotMatch(yaml(), /git push/);
	// The built-in rules clear this one.
	await call("duty", { agent: "alpha", name: "nightly", every: "1d", check: "cat backups.log", wake: "failed", brief: "Fix it." });
	assert.match(await result(), /^Replaced Alpha's duty: nightly, every 1d: runs `cat backups\.log`, wakes when it fails\. Brief: Fix it\./);
	await call("duty", { agent: "alpha", name: "weekly", every: "1w", brief: "x" });
	assert.match(await result(), /^duty weekly: every must be like 15m/);

	await call("duty", { agent: "alpha", name: "nightly", remove: true });
	assert.match(await result(), /^Removed Alpha's duty nightly\. It was \{"name":"nightly","every":"1d","check":"cat backups.log","wake":"failed","brief":"Fix it."\}\.$/);
	await until(async () => (await d.duties()).length === 1);
	assert.equal(yaml(), "{}\n");

	// Found while adding the duty tool: the supervisor's read_file had no guard, so she could read stomp's secrets unasked.
	const reading = call("read_file", { path: "/proc/self/environ" });
	const read = await d.ask();
	assert.deepEqual([read.command, read.why], ["read_file /proc/self/environ", "rule: stomp's own files"]);
	assert.equal(await d.answer(read.id, { decision: "deny" }), 200);
	await reading;
});
