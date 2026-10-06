import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { REPORT_PREFIX } from "../src/shared/protocol.ts";
import { startStomp } from "../src/server/stomp.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { type Request, scriptedModels, type Turn } from "./support/scripted.ts";

/** The supervisor: "two jobs", "delegate <brief>" and "cancel <thread>" call tools; reports are acknowledged by quoting. */
function boss(r: Request): Turn {
	const said = r.lastUserText;
	if (r.toolResults > 0) return { text: "on it" };
	if (said.startsWith("[report from")) return { text: `ack ${said}` };
	if (said === "two jobs") return { calls: [["delegate", { agent: "alpha", brief: "job A" }], ["delegate", { agent: "Beta", brief: "job B" }]] };
	if (said.startsWith("delegate ")) return { calls: [["delegate", { agent: "alpha", brief: said.slice(9) }]] };
	if (said.startsWith("cancel ")) return { calls: [["cancel", { thread: Number(said.slice(7)) }]] };
	return { text: `boss: ${said}` };
}

const textOf = (m: Message) => (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join(""));

/** A supervisor and two agents that answer "<model> did <input>" after `delayMs` (a minute when the input says slow). */
async function startTeam(t: TestContext, delayMs: number) {
	const fx = fixture();
	fx.agent("boss", agentFile("Boss", "scripted/w0", "role: supervisor\n"));
	fx.agent("alpha", `${agentFile("Alpha", "scripted/w1")}\n## Responsibilities\n- alpha things\n`);
	fx.agent("beta", agentFile("Beta", "scripted/w2"));
	const systems: Record<string, string> = {};
	const models = scriptedModels(
		(r) => {
			systems[r.model] = r.system;
			if (r.model === "w0") return boss(r);
			return { text: `${r.model} did ${r.lastUserText}`, delayMs: r.lastUserText.includes("slow") ? 60_000 : delayMs };
		},
		["w0", "w1", "w2"],
	);
	const open = () => startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models });
	let stomp = await open();
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const conversation = async (id: number) => (await stomp.harness.conversation(id as ConversationId, ctx))!;
	const messages = async (id: number, role: Message["role"]) =>
		(await (await conversation(id)).entries({}, 200, undefined, ctx)).items
			.toReversed()
			.flatMap((e) => e.model ?? [])
			.filter((m) => m.role === role);
	const threads = async () => (await stomp.state()).threads;
	const team = {
		systems,
		boss: (await stomp.state()).agents.find((a) => a.role === "supervisor")!.deskThread,
		state: () => stomp.state(),
		thread: async (id: number) => (await threads()).find((thread) => thread.id === id)!,
		delegated: async () => (await threads()).filter((thread) => thread.delegatedBy === team.boss),
		say: async (id: number, text: string, whenBusy?: "steer") =>
			(await (await conversation(id)).submit({ type: "input", content: text, ...(whenBusy && { whenBusy }) }, ctx)).wait(ctx),
		messages,
		texts: async (id: number, role: Message["role"]) => (await messages(id, role)).map(textOf),
		reports: async () => (await team.texts(team.boss, "user")).filter((text) => REPORT_PREFIX.test(text)),
		async restart() {
			await stomp.close();
			stomp = await open();
		},
	};
	return team;
}

test("the supervisor delegates two jobs in one turn and hears each report once", async (t) => {
	const team = await startTeam(t, 500);
	await team.say(team.boss, "two jobs");
	const running = await team.delegated();
	assert.deepEqual(running.map((x) => [x.agent, x.title, x.desk, x.delegation]), [["alpha", "job A", false, "running"], ["beta", "job B", false, "running"]]);
	const [a, b] = running.map((x) => x.id);
	const results = (await team.messages(team.boss, "toolResult")).map((m) => m.role === "toolResult" && [textOf(m), m.details]);
	assert.deepEqual(results, [[`Delegated to Alpha as thread ${a}.`, { agent: "alpha", thread: a }], [`Delegated to Beta as thread ${b}.`, { agent: "beta", thread: b }]]);

	await until(async () => (await team.delegated()).every((x) => x.delegation === "reported"));
	const acks = (await team.texts(team.boss, "assistant")).filter((text) => text.startsWith("ack "));
	assert.deepEqual(acks.toSorted(), [`ack [report from Alpha, thread ${a}] w1 did job A`, `ack [report from Beta, thread ${b}] w2 did job B`]);
	assert.equal((await team.reports()).length, 2);
	assert.deepEqual((await team.state()).usage.map((u) => u.provider), ["scripted"]);
	assert.match(team.systems.w0!, /- Alpha \(id: alpha, test\)\n {2}- alpha things\n- Beta \(id: beta, test\)\n\n/);
	assert.doesNotMatch(team.systems.w1!, /Your team/);
});

test("a steer typed into a delegated thread mid-work is part of the report", async (t) => {
	const team = await startTeam(t, 600);
	await team.say(team.boss, "delegate job A");
	const [thread] = await team.delegated();
	await until(async () => (await team.thread(thread!.id)).status === "working");
	await team.say(thread!.id, "also B", "steer");
	await until(async () => (await team.thread(thread!.id)).delegation === "reported");
	// A steer during a text-only turn gets its own answer; the report carries both.
	assert.deepEqual(await team.reports(), [`[report from Alpha, thread ${thread!.id}] w1 did job A\n\nw1 did also B`]);
});

test("a follow-up answered separately adds to the report instead of replacing the brief's answer", async (t) => {
	const team = await startTeam(t, 600);
	await team.say(team.boss, "delegate job A");
	const [thread] = await team.delegated();
	await until(async () => (await team.thread(thread!.id)).status === "working");
	await team.say(thread!.id, "also B");
	await until(async () => (await team.thread(thread!.id)).delegation === "reported");
	const [report] = await team.reports();
	assert.match(report!, /w1 did job A\n\nw1 did also B$/);
});

test("cancel stops the delegation and the thread, and the thread still takes input", async (t) => {
	const team = await startTeam(t, 100);
	await team.say(team.boss, "delegate slow job");
	const [thread] = await team.delegated();
	await until(async () => (await team.thread(thread!.id)).status === "working");
	await team.say(team.boss, `cancel ${thread!.id}`);
	await until(async () => {
		const info = await team.thread(thread!.id);
		return info.status === "idle" && info.delegation === "cancelled";
	});
	await team.say(thread!.id, "hello");
	assert.equal((await team.texts(thread!.id, "assistant")).at(-1), "w1 did hello");
	assert.deepEqual(await team.reports(), []);
});

test("a restart between deliver and report reports exactly once", async (t) => {
	const team = await startTeam(t, 1500);
	await team.say(team.boss, "delegate job A");
	const [thread] = await team.delegated();
	await until(async () => (await team.thread(thread!.id)).status === "working");
	await team.restart();
	await until(async () => (await team.thread(thread!.id)).delegation === "reported", 15_000);
	assert.deepEqual(await team.reports(), [`[report from Alpha, thread ${thread!.id}] w1 did job A`]);
});
