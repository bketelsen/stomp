import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Ask, JudgeDecision } from "../src/shared/protocol.ts";
import { UNAUTHORIZED } from "../src/server/http.ts";
import { startStomp } from "../src/server/stomp.ts";
import { fakeServer, jevAnswer } from "./support/fakes.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { type Request, scriptedModels, type Turn } from "./support/scripted.ts";

// The judge reads its key from the server's environment; agents' shells must not see it, or $STOMP_STATE/env's secrets.
const jev = await fakeServer((body) => jevAnswer(body.state.command.includes("outward") ? [0, 0, 0.1, 0.9] : [0.9, 0.1, 0, 0]));
after(jev.close);
process.env.TYPESAFE_API_KEY = "test-key";
process.env.STOMP_JEV_URL = jev.url;
process.env.OTHER_SECRET = "other-value";

/** Agents run what follows "run: "; the supervisor delegates what follows "delegate ". */
function respond(r: Request): Turn {
	if (r.lastTool !== undefined) return { text: "done" };
	if (r.model === "w0" && r.lastUserText.startsWith("delegate ")) return { calls: [["delegate", { agent: "alpha", brief: r.lastUserText.slice(9) }]] };
	const call = /^call: (\w+) (.*)/.exec(r.lastUserText);
	if (call) return { calls: [[call[1]!, JSON.parse(call[2]!)]] };
	const command = /^run: (.*)/.exec(r.lastUserText)?.[1];
	return command ? { bash: command } : { text: `heard ${r.lastUserText.slice(0, 30)}` };
}

async function start(t: TestContext) {
	const fx = fixture();
	writeFileSync(join(fx.configDir, "rules.yaml"), "ask: ['echo ask **']\n");
	mkdirSync(fx.stateDir, { recursive: true });
	writeFileSync(join(fx.stateDir, "env"), "OTHER_SECRET=other-value\n");
	fx.agent("boss", agentFile("Boss", "scripted/w0", "role: supervisor\n"));
	fx.agent("alpha", agentFile("Alpha", "scripted/w1"));
	const models = scriptedModels(respond, ["w0", "w1"]);
	const open = () => startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models });
	let stomp = await open();
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const runs = join(fx.root, "runs.txt");
	const s = {
		/** stomp's address, for an agent's curl. */
		url: () => stomp.url,
		runs,
		ran: () => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean).length : 0),
		state: () => stomp.state(),
		desk: async (agent: string) => (await stomp.state()).agents.find((a) => a.id === agent)!.deskThread,
		/** Submit without waiting: a command that asks holds the turn open. */
		say: async (thread: number, text: string) =>
			(await (await stomp.harness.conversation(thread as ConversationId, ctx))!.submit({ type: "input", content: text }, ctx)).wait(ctx),
		ask: () => until(async () => (await stomp.state()).asks[0]),
		answer: async (id: string, body: unknown) =>
			(await fx.fetch(`${stomp.url}/api/asks/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) })).status,
		newThread: async (agent: string) =>
			((await (await fx.fetch(`${stomp.url}/api/agents/${agent}/threads`, { method: "POST", body: "{}" })).json()) as { thread: number }).thread,
		decisions: async () => ((await (await fx.fetch(`${stomp.url}/api/judge?limit=50`)).json()) as { decisions: JudgeDecision[] }).decisions,
		/** The text of every bash result in the thread, oldest first. */
		results: async (thread: number) =>
			(await (await stomp.harness.conversation(thread as ConversationId, ctx))!.entries({}, 200, undefined, ctx)).items
				.toReversed()
				.flatMap((e) => e.model ?? [])
				.flatMap((m) => (m.role === "toolResult" ? [m.content.map((c) => ("text" in c ? c.text : "")).join("")] : [])),
		async restart() {
			await stomp.close();
			stomp = await open();
		},
	};
	return s;
}

test("an ask answered allow runs once, deny blocks with Brian's note, and always runs it from then on", async (t) => {
	const s = await start(t);
	const desk = await s.desk("alpha");
	const first = s.say(desk, `run: echo ask >> ${s.runs}`);
	const ask = await s.ask();
	assert.deepEqual({ ...ask, id: "", createdAt: 0 }, {
		id: "",
		thread: desk,
		agent: "alpha",
		command: `echo ask >> ${s.runs}`,
		cwd: join(s.runs, "..", "state", "scratch", "alpha"),
		why: "rule: echo ask **",
		createdAt: 0,
	} satisfies Ask);
	const state = await s.state();
	assert.deepEqual([state.threads.find((x) => x.id === desk)!.status, state.agents.find((a) => a.id === "alpha")!.status], ["needs-you", "needs-you"]);
	assert.equal(s.ran(), 0);
	assert.equal(await s.answer(ask.id, { decision: "allow" }), 200);
	await first;
	assert.equal(s.ran(), 1);
	assert.equal(await s.answer(ask.id, { decision: "allow" }), 404, "answered asks are gone");
	assert.equal(await s.answer(ask.id, { decision: "maybe" }), 400);
	assert.deepEqual((await s.state()).asks, []);
	assert.equal((await s.state()).threads.find((x) => x.id === desk)!.status, "idle");

	const second = s.say(desk, `run: echo ask again >> ${s.runs}`);
	assert.equal(await s.answer((await s.ask()).id, { decision: "deny", note: "not now" }), 200);
	await second;
	assert.match((await s.results(desk)).at(-1)!, /Brian declined: not now/);
	assert.equal(s.ran(), 1);

	const third = s.say(desk, `run: echo ask >> ${s.runs}`);
	assert.equal(await s.answer((await s.ask()).id, { decision: "always" }), 200);
	await third;
	const learned = readFileSync(join(s.runs, "..", "state", "allowed.yaml"), "utf8");
	assert.equal(learned, `agents:\n  alpha:\n    allow:\n      - re:^echo ask >> ${s.runs.replaceAll(".", "\\.")}$\n`, "exactly that command");
	await s.say(desk, `run: echo ask >> ${s.runs}`);
	assert.equal(s.ran(), 3, "the learned rule ran it without asking");

	const decisions = await s.decisions();
	assert.deepEqual(
		decisions.slice(0, 7).map((d) => [d.outcome, d.by, d.answer]),
		[["run", "allow-rule", undefined], ["ask", "ask-rule", "always"], ["ask", "ask-rule", undefined], ["ask", "ask-rule", "deny"], ["ask", "ask-rule", undefined], ["ask", "ask-rule", "allow"], ["ask", "ask-rule", undefined]],
	);
});

test("commands no rule decides go to Jev, and agents' shells don't see the server's secrets", async (t) => {
	const s = await start(t);
	const desk = await s.desk("alpha");
	await s.say(desk, `run: seq 2 >> ${s.runs}`);
	assert.equal(s.ran(), 2);
	assert.equal((await s.decisions())[0]!.by, "jev");
	const outward = s.say(desk, "run: seq 1 # outward");
	assert.match((await s.ask()).why, /^jev: remote_irreversible 0\.90$/);
	assert.equal(await s.answer((await s.ask()).id, { decision: "deny" }), 200);
	await outward;
	assert.match((await s.results(desk)).at(-1)!, /Brian declined: no reason given/);

	await s.say(desk, "run: env");
	const env = (await s.results(desk)).at(-1)!;
	assert.match(env, /PATH=/);
	assert.doesNotMatch(env, /TYPESAFE_API_KEY|test-key|OTHER_SECRET|other-value/);
	const printenv = s.say(desk, "run: printenv TYPESAFE_API_KEY");
	assert.equal((await s.ask()).why, "rule: names a stomp secret");
	assert.equal(await s.answer((await s.ask()).id, { decision: "allow" }), 200);
	await printenv;
	assert.doesNotMatch((await s.results(desk)).at(-1)!, /test-key/);
});

test("a restart while an ask waits asks again with the same id, and the command runs once", async (t) => {
	const s = await start(t);
	const desk = await s.desk("alpha");
	void s.say(desk, `run: echo ask >> ${s.runs}`).catch(() => {});
	const before = await s.ask();
	await s.restart();
	const again = await s.ask();
	assert.equal(s.ran(), 0);
	assert.deepEqual([again.id, again.thread, again.command], [before.id, before.thread, before.command]);
	assert.equal(await s.answer(again.id, { decision: "allow" }), 200);
	await until(async () => s.ran() === 1 && (await s.state()).threads.every((x) => x.status === "idle"));
	assert.equal(s.ran(), 1);
});

test("a delegated agent's ask shows as needs-you on its thread and reaches Brian like any other", async (t) => {
	const s = await start(t);
	await s.say(await s.desk("boss"), `delegate run: echo ask >> ${s.runs}`);
	const ask = await s.ask();
	const state = await s.state();
	const thread = state.threads.find((x) => x.delegatedBy !== undefined)!;
	assert.deepEqual([ask.thread, ask.agent, thread.status, thread.delegation], [thread.id, "alpha", "needs-you", "running"]);
	assert.equal(state.agents.find((a) => a.id === "alpha")!.status, "needs-you");
	assert.equal(await s.answer(ask.id, { decision: "allow" }), 200);
	await until(async () => (await s.state()).threads.find((x) => x.id === thread.id)!.delegation === "reported");
	assert.equal(s.ran(), 1);
});

// Found by cross-family review: file tools skipped the guard, so an agent could read stomp's secrets or approve itself.
test("file tools ask before touching stomp's own files, and always allows just once", async (t) => {
	const s = await start(t);
	const desk = await s.desk("alpha");
	const [state, config] = [join(s.runs, "..", "state"), join(s.runs, "..", "config")];
	const tool = (name: string, args: object) => s.say(desk, `call: ${name} ${JSON.stringify(args)}`);
	const last = async () => (await s.results(desk)).at(-1)!;
	mkdirSync(join(state, "scratch", "alpha"), { recursive: true });
	writeFileSync(join(state, "scratch", "alpha", "notes.txt"), "plain notes\n");
	await tool("read", { path: "notes.txt" });
	assert.match(await last(), /plain notes/);
	assert.deepEqual((await s.state()).asks, []);

	const read = tool("read", { path: "../../work/../env" });
	const ask = await s.ask();
	assert.deepEqual([ask.command, ask.why, ask.agent, ask.once], ["read ../../work/../env", "rule: stomp's own files", "alpha", true]);
	assert.equal(await s.answer(ask.id, { decision: "allow" }), 200);
	await read;
	assert.match(await last(), /OTHER_SECRET=other-value/);

	const write = tool("write", { path: join(config, "rules.yaml"), content: "allow: ['re:.']\n" });
	assert.equal(await s.answer((await s.ask()).id, { decision: "deny", note: "no" }), 200);
	await write;
	assert.match(await last(), /Brian declined: no/);
	assert.equal(readFileSync(join(config, "rules.yaml"), "utf8"), "ask: ['echo ask **']\n");

	const home = tool("read", { path: "~/.local/share/stomp/env" });
	assert.equal((await s.ask()).command, "read ~/.local/share/stomp/env");
	assert.equal(await s.answer((await s.ask()).id, { decision: "deny" }), 200);
	await home;

	for (const decision of ["always", "deny"]) {
		const edit = tool("edit", { path: join(state, "allowed.yaml"), edits: [{ oldText: "x", newText: "y" }] });
		assert.equal(await s.answer((await s.ask()).id, { decision }), 200);
		await edit;
	}
	assert.equal(existsSync(join(state, "allowed.yaml")), false, "always on a file ask learns nothing");
});

// Found by cross-family review: a failed save of "always" left the ask unanswered forever.
test("when always can't be saved, the command still runs once and the answer reports the error", async (t) => {
	const s = await start(t);
	const desk = await s.desk("alpha");
	mkdirSync(join(s.runs, "..", "state", "allowed.yaml"));
	const run = s.say(desk, `run: echo ask >> ${s.runs}`);
	assert.equal(await s.answer((await s.ask()).id, { decision: "always" }), 500);
	await until(() => s.ran() === 1);
	await run;
	assert.deepEqual((await s.state()).asks, []);
});

// Found while reading the code: with no token, an agent's curl read the asks from stomp's API and answered its own.
test("an agent's curl to stomp's API is refused, so its ask waits for Brian", async (t) => {
	const s = await start(t);
	const asking = s.say(await s.desk("alpha"), `run: echo ask >> ${s.runs}`);
	const ask = await s.ask();
	const other = await s.newThread("alpha");
	await s.say(other, `run: curl -s ${s.url()}/api/state`);
	await s.say(other, `run: curl -s -X POST '${s.url()}/api/asks/${encodeURIComponent(ask.id)}' -d '{"decision":"always"}'`);
	assert.deepEqual((await s.results(other)).slice(-2), Array(2).fill(JSON.stringify({ error: UNAUTHORIZED })));
	assert.deepEqual([(await s.state()).asks.map((a) => a.id), s.ran()], [[ask.id], 0]);
	assert.equal(await s.answer(ask.id, { decision: "allow" }), 200);
	await asking;
	assert.equal(s.ran(), 1);
});
