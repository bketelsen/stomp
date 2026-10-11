import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JudgeDecision } from "../src/shared/protocol.ts";
import { startStomp } from "../src/server/stomp.ts";
import { fakeServer, jevAnswer } from "./support/fakes.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { type Request, scriptedModels, type Turn } from "./support/scripted.ts";

// Jev reads a call labelled "outward" as irreversible, anything else as local. NAS_SECRET is in the server's environment
// and in $STOMP_STATE/env, as deploy/vm.sh secret puts it.
const jev = await fakeServer((body) => jevAnswer(body.state.command.includes("outward") ? [0, 0, 0.1, 0.9] : [0.9, 0.1, 0, 0]));
after(jev.close);
process.env.TYPESAFE_API_KEY = "test-key";
process.env.STOMP_JEV_URL = jev.url;
process.env.NAS_SECRET = "nas-value";

async function start(t: TestContext) {
	const fx = fixture();
	const log = join(fx.root, "mcp.log");
	const starts = join(fx.root, "starts.log");
	const server = [join(import.meta.dirname, "support", "mcp-server.ts")];
	const fake = { command: process.execPath, args: server, env: { FAKE_LOG: log, FAKE_FLAG: join(fx.root, "tag-is-destructive"), FAKE_STARTS: starts, FAKE_DOWN: join(fx.root, "fake-down") } };
	const broken = { command: join(fx.root, "no-such-server") };
	// Down at startup, like the NAS mid-upgrade, until a test removes $FAKE_DOWN.
	const flaky = { command: process.execPath, args: server, env: { FAKE_LOG: log, FAKE_DOWN: join(fx.root, "down") } };
	writeFileSync(join(fx.root, "down"), "");
	writeFileSync(join(fx.configDir, "stomp.yaml"), `families: { '^(w[0-9]|scripted)': test }\nmcp: ${JSON.stringify({ fake, broken, flaky })}\n`);
	mkdirSync(fx.stateDir, { recursive: true });
	writeFileSync(join(fx.stateDir, "env"), "NAS_SECRET=nas-value\n");
	fx.agent("alpha", agentFile("Alpha", "scripted/w1", "mcp: [fake]\n"));
	fx.agent("beta", agentFile("Beta", "scripted/w2"));
	fx.agent("gamma", agentFile("Gamma", "scripted/w2", "mcp: [nope]\n"));
	fx.agent("delta", agentFile("Delta", "scripted/w2", "mcp: [broken]\n"));
	fx.agent("epsilon", agentFile("Epsilon", "scripted/w3", "mcp: [flaky]\n"));
	const seen: Record<string, string[]> = {};
	const system: Record<string, string> = {};
	const respond = (r: Request): Turn => {
		seen[r.model] = r.tools;
		system[r.model] = r.system;
		if (r.lastTool !== undefined) return { text: "done" };
		const call = /^call: (\w+) (.*)/.exec(r.lastUserText);
		const command = /^run: (.*)/.exec(r.lastUserText)?.[1];
		return call ? { calls: [[call[1]!, JSON.parse(call[2]!)]] } : command ? { bash: command } : { text: "hi" };
	};
	const stomp = await startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models: scriptedModels(respond, ["w1", "w2", "w3"]) });
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const desk = async (agent: string) => (await stomp.state()).agents.find((a) => a.id === agent)!.deskThread;
	const say = async (thread: number, text: string) =>
		(await (await stomp.harness.conversation(thread as ConversationId, ctx))!.submit({ type: "input", content: text }, ctx)).wait(ctx);
	const alpha = await desk("alpha");
	return {
		fx,
		seen,
		/** The system prompt of each model's latest request. */
		system,
		/** Chat as the UI does; the status a 409 would show in. */
		chat: async (thread: number, text: string) => (await fx.fetch(`${stomp.url}/api/threads/${thread}/messages`, { method: "POST", body: JSON.stringify({ text }) })).status,
		state: () => stomp.state(),
		desk,
		say,
		/** Alpha calls a tool; a call that asks holds the turn open. */
		tool: (name: string, args: object) => say(alpha, `call: ${name} ${JSON.stringify(args)}`),
		/** Alpha's (or another thread's) latest tool result. */
		last: async (thread = alpha) =>
			(await (await stomp.harness.conversation(thread as ConversationId, ctx))!.entries({}, 200, undefined, ctx)).items
				.flatMap((e) => e.model ?? [])
				.flatMap((m) => (m.role === "toolResult" ? [m.content.map((c) => ("text" in c ? c.text : "")).join("")] : []))[0]!,
		ask: () => until(async () => (await stomp.state()).asks[0]),
		answer: async (id: string, body: unknown) => (await fx.fetch(`${stomp.url}/api/asks/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) })).status,
		decision: async () => ((await (await fx.fetch(`${stomp.url}/api/judge?limit=1`)).json()) as { decisions: JudgeDecision[] }).decisions[0]!,
		/** What reached the MCP server. */
		logged: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
		/** How many times fake has started. */
		started: () => (existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").length : 0),
		/** Kill fake's latest process, as a crash would. */
		kill: () => process.kill(Number(readFileSync(starts, "utf8").trim().split("\n").at(-1))),
		error: async (agent: string) => (await stomp.state()).agents.find((a) => a.id === agent)!.error,
		unavailable: async (agent: string) => (await stomp.state()).agents.find((a) => a.id === agent)!.unavailable,
	};
}

test("an agent whose file lists a server has its tools; others don't, an unknown server is an agent error and a broken one isn't", async (t) => {
	const s = await start(t);
	const agents = (await s.state()).agents;
	assert.equal(agents.find((a) => a.id === "gamma")!.error, 'unknown MCP server "nope"');
	const delta = agents.find((a) => a.id === "delta")!;
	assert.equal(delta.error, undefined);
	assert.match(delta.unavailable!, /^MCP server broken is unavailable \(.*ENOENT.*\); retrying$/);
	await s.say(await s.desk("beta"), "hello");
	await s.tool("fake_wipe", {});
	assert.match(await s.last(), /Validation failed for tool "fake_wipe"[\s\S]*dataset/, "the tool has the server's schema");
	// Every MCP tool is named <server>_<tool>, so two servers' tools never share a name (found by review).
	const tools = ["fake_read", "fake_wipe", "fake_tag", "fake_exit"];
	assert.deepEqual([s.seen.w1, s.seen.w2].map((seen) => tools.filter((name) => seen!.includes(name))), [tools, []]);
});

test("MCP calls are judged like commands: read-only runs, destructive asks, the rest goes to Jev, and Brian's rules come first", async (t) => {
	const s = await start(t);
	const asked = jev.requests.length;
	await s.tool("fake_read", { name: "NAS_SECRET" });
	// The server has the secret (its log below says so); what comes back to the agent is redacted (found by review).
	assert.equal(await s.last(), "NAS_SECRET=[redacted]");
	assert.deepEqual([(await s.decision()).command, (await s.decision()).by, jev.requests.length], [`mcp fake read --read-only '{"name":"NAS_SECRET"}'`, "allow-rule", asked]);

	const wipe = s.tool("fake_wipe", { dataset: "tank's" });
	const ask = await s.ask();
	assert.deepEqual([ask.command, ask.why, ask.agent], [`mcp fake wipe --destructive '{"dataset":"tank'\\''s"}'`, "rule: destructive MCP tool", "alpha"]);
	assert.equal(await s.answer(ask.id, { decision: "allow" }), 200);
	await wipe;
	assert.equal(await s.last(), "wiped tank's");
	const denied = s.tool("fake_wipe", { dataset: "pool" });
	assert.equal(await s.answer((await s.ask()).id, { decision: "deny", note: "not that one" }), 200);
	await denied;
	assert.match(await s.last(), /Brian declined: not that one/);

	await s.tool("fake_tag", { dataset: "tank", label: "blue" });
	assert.deepEqual([await s.last(), (await s.decision()).by, jev.requests.at(-1)!.body.state.command], ["tagged tank blue", "jev", `mcp fake tag '{"dataset":"tank","label":"blue"}'`]);
	const outward = s.tool("fake_tag", { dataset: "tank", label: "outward" });
	assert.match((await s.ask()).why, /^jev: remote_irreversible/);
	assert.equal(await s.answer((await s.ask()).id, { decision: "allow" }), 200);
	await outward;

	writeFileSync(join(s.fx.configDir, "rules.yaml"), "agents:\n  alpha:\n    allow: ['mcp fake wipe **']\n");
	await s.tool("fake_wipe", { dataset: "scratch" });
	assert.deepEqual([await s.last(), (await s.decision()).by], ["wiped scratch", "allow-rule"]);
	assert.deepEqual(s.logged(), ["NAS_SECRET=nas-value", "wiped tank's", "tagged tank blue", "tagged tank outward", "wiped scratch"]);
});

test("a server that exits is down at once, until it's back on its own; agents' shells never see its secrets", async (t) => {
	const s = await start(t);
	await s.tool("fake_exit", {});
	assert.match(await s.last(), /^mcp fake: .*Connection closed/);
	assert.equal(await s.unavailable("alpha"), "MCP server fake is unavailable (it disconnected); retrying");
	await s.say(await s.desk("alpha"), "hello");
	assert.ok(!s.seen.w1!.includes("fake_read"), "the turn right after has no fake tools");
	assert.match(s.system.w1!, /MCP server fake is unavailable \(it disconnected\)/);
	await until(async () => (await s.unavailable("alpha")) === undefined);
	await s.tool("fake_read", { name: "NAS_SECRET" });
	assert.equal(await s.last(), "NAS_SECRET=[redacted]");
	await s.say(await s.desk("alpha"), "run: printenv NAS_SECRET; echo checked");
	assert.match(await s.last(), /checked/);
	assert.doesNotMatch(await s.last(), /nas-value/);
});

// Found in use: the NAS was mid-upgrade when stomp started, and its server stayed failed until stomp restarted. Then
// Moneo couldn't even say the NAS was unreachable: an agent with a down server was an error, and chat a 409.
test("an agent whose server is down chats without its tools, is told why, and has them once it's up", async (t) => {
	const s = await start(t);
	assert.equal(await s.error("epsilon"), undefined);
	assert.match((await s.unavailable("epsilon"))!, /^MCP server flaky is unavailable \(.*Connection closed\); retrying$/);
	const epsilon = await s.desk("epsilon");
	assert.equal(await s.chat(epsilon, "is the NAS up?"), 200);
	await until(() => s.system.w3);
	assert.match(s.system.w3!, /MCP server flaky is unavailable \(.*Connection closed\), so its tools are missing; stomp keeps retrying/);
	assert.ok(!s.seen.w3!.some((tool) => tool.startsWith("flaky_")));
	rmSync(join(s.fx.root, "down"));
	await until(async () => (await s.unavailable("epsilon")) === undefined);
	await s.say(epsilon, 'call: flaky_read {"name":"HOME"}');
	assert.match(await s.last(epsilon), /^HOME=/);
	assert.ok(s.seen.w3!.includes("flaky_read"));
	assert.doesNotMatch(s.system.w3!, /unavailable/);
});

test("a server that exits mid-run starts again without waiting for a call; while it can't, its agents chat without its tools", async (t) => {
	const s = await start(t);
	assert.equal(s.started(), 1);
	writeFileSync(join(s.fx.root, "fake-down"), "");
	await s.tool("fake_exit", {});
	assert.match(await until(() => s.unavailable("alpha")), /^MCP server fake is unavailable \(.*\); retrying$/);
	await s.say(await s.desk("alpha"), "hello");
	assert.ok(!s.seen.w1!.includes("fake_read"));
	assert.match(s.system.w1!, /MCP server fake is unavailable/);
	rmSync(join(s.fx.root, "fake-down"));
	await until(async () => (await s.unavailable("alpha")) === undefined);
	assert.equal(s.started(), 2);
	await s.tool("fake_read", { name: "NAS_SECRET" });
	assert.equal(await s.last(), "NAS_SECRET=[redacted]");
	assert.equal(s.started(), 2, "the call found it running");
});

// Found by review: a file tool could read a process environment, which holds the server's and MCP servers' secrets.
test("reading a process environment with a file tool asks", async (t) => {
	const s = await start(t);
	const reading = s.say(await s.desk("alpha"), 'call: read {"path":"/proc/self/environ"}');
	const ask = await s.ask();
	assert.deepEqual([ask.command, ask.why], ["read /proc/self/environ", "rule: stomp's own files"]);
	assert.equal(await s.answer(ask.id, { decision: "deny" }), 200);
	await reading;
	assert.match(await s.last(), /Brian declined/);
});

// Found by review: a call judged against a tool's old annotations must not run once a restart changed them. Here the
// server restarts while Brian is still deciding on the call.
test("a call whose tool changed across a server restart isn't made, and its retry is judged afresh", async (t) => {
	const s = await start(t);
	const call = s.tool("fake_tag", { dataset: "tank", label: "outward" });
	const ask = await s.ask();
	writeFileSync(join(s.fx.root, "tag-is-destructive"), "");
	s.kill();
	await until(() => s.started() === 2 && s.unavailable("alpha").then((u) => u === undefined));
	assert.equal(await s.answer(ask.id, { decision: "allow" }), 200);
	await call;
	assert.match(await s.last(), /^mcp fake: tag changed when the server restarted; call it again/);
	const retry = s.tool("fake_tag", { dataset: "tank", label: "blue" });
	assert.equal((await s.ask()).why, "rule: destructive MCP tool");
	assert.equal(await s.answer((await s.ask()).id, { decision: "deny" }), 200);
	await retry;
	assert.ok(!s.logged().some((line) => line.startsWith("tagged")), "the tag never reached the server");
});
