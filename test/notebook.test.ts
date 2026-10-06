import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { startStomp } from "../src/server/stomp.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { type Request, scriptedModels, type Turn } from "./support/scripted.ts";

/** Alpha: "remember <note>", "tidy <text>" and "consult <agent> <question>" call tools. */
function alpha(r: Request): Turn {
	const [verb, ...rest] = r.lastUserText.split(" ");
	if (r.toolResults > 0) return { text: "done" };
	if (verb === "remember") return { calls: [["remember", { note: rest.join(" ") }]] };
	if (verb === "tidy") return { calls: [["notebook", { text: rest.join(" ") }]] };
	if (verb === "consult") return { calls: [["consult", { agent: rest[0]!, question: rest.slice(1).join(" ") }]] };
	return { text: "ok" };
}

const textOf = (m: Message) => (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join(""));

/** Alpha and Beta (whose model also serves Beta's consult copies, slowly when asked to), and a broken agent. */
async function startNotes(t: TestContext) {
	const fx = fixture();
	fx.agent("alpha", agentFile("Alpha", "scripted/w1"));
	fx.agent("beta", agentFile("Beta", "scripted/w2"));
	fx.agent("broken", agentFile("Broken", "nope"));
	const requests: Request[] = [];
	const models = scriptedModels(
		(r) => {
			requests.push(r);
			if (r.model === "w1") return alpha(r);
			return { text: `Observed: beta read "${r.lastUserText}"`, delayMs: r.lastUserText.includes("slow") ? 1500 : 0 };
		},
		["w1", "w2"],
	);
	const open = () => startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models });
	let stomp = await open();
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const conversation = async (id: number) => (await stomp.harness.conversation(id as ConversationId, ctx))!;
	const messages = async (id: number) => (await (await conversation(id)).entries({}, 200, undefined, ctx)).items.toReversed().flatMap((e) => e.model ?? []);
	const n = {
		requests,
		desk: async (agent: string) => (await stomp.state()).agents.find((a) => a.id === agent)!.deskThread,
		agent: async (agent: string) => (await stomp.state()).agents.find((a) => a.id === agent)!,
		say: async (id: number, text: string) => (await (await conversation(id)).submit({ type: "input", content: text }, ctx)).wait(ctx),
		results: async (id: number) => (await messages(id)).filter((m) => m.role === "toolResult").map((m) => [textOf(m), m.role === "toolResult" && m.isError]),
		api: (path: string, method = "GET", body?: unknown) =>
			fetch(`${stomp.url}/api/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
		/** Consult copies: conversations owned by tool calls in thread `id`. */
		copies: (id: number) => stomp.harness.commit(async (tx) => (await tx.scanConversations({ ownerConversationId: id as ConversationId }, 10)).items, ctx),
		messages,
		sectionKeys: async (id: number) => (await messages(id)).flatMap((m) => (m.role === "system" && m.sections ? [Object.keys(m.sections)] : [])),
		state: () => stomp.state(),
		async restart() {
			await stomp.close();
			stomp = await open();
		},
	};
	return n;
}

test("remember adds a dated line that the agent's threads see; past the cap it asks for a tidy, and notebook rewrites", async (t) => {
	const n = await startNotes(t);
	const desk = await n.desk("alpha");
	await n.say(desk, "remember the VM is devbox");
	const note = /^- \d{4}-\d{2}-\d{2}: the VM is devbox\n$/;
	assert.match(((await (await n.api("agents/alpha/notebook")).json()) as { text: string }).text, note);
	assert.deepEqual(await n.results(desk), [["Remembered.", false]]);
	// The request after the tool call already has the notebook, and so does a new thread.
	assert.match(n.requests.at(-1)!.system, /<notebook>\n- \d{4}-\d{2}-\d{2}: the VM is devbox\n<\/notebook>/);
	const { thread } = (await (await n.api("agents/alpha/threads", "POST", {})).json()) as { thread: number };
	await n.say(thread, "hi");
	assert.match(n.requests.at(-1)!.system, /the VM is devbox/);
	await n.say(thread, "hi again");
	await n.say(await n.desk("beta"), "hi");
	assert.match(n.requests.at(-1)!.system, /<notebook>\n\(empty\)\n<\/notebook>/, "only alpha's threads see alpha's notebook");
	assert.equal((await n.agent("alpha")).notes, 1);
	// Seeded in render order and re-sent only when it changes: the desk gets one in-place patch, the new thread none.
	assert.deepEqual(await n.sectionKeys(desk), [["notebook", "instructions"], ["notebook"]]);
	assert.deepEqual(await n.sectionKeys(thread), [["notebook", "instructions"]]);

	const full = Array.from({ length: 150 }, (_, i) => `- note ${i}`).join("\n");
	assert.equal((await n.api("agents/alpha/notebook", "PUT", { text: full })).status, 200);
	assert.equal((await n.agent("alpha")).notes, 150);
	await n.say(desk, "remember one more");
	assert.match((await n.results(desk)).at(-1)![0] as string, /^Remembered\. Your notebook is full \(151 lines; the cap is 150\)\. .*notebook\(\{text\}\)/);
	await n.say(desk, "tidy - the VM is devbox");
	assert.deepEqual((await n.results(desk)).at(-1), ["Saved your notebook (1 of 150 lines).", false]);
	assert.deepEqual(await (await n.api("agents/alpha/notebook")).json(), { text: "- the VM is devbox\n" });
	assert.equal((await n.agent("alpha")).notes, 1);

	assert.deepEqual(await (await n.api("agents/nobody/notebook", "PUT", { text: "x" })).json(), { error: "no agent nobody" });
	assert.equal((await n.api("agents/nobody/notebook")).status, 404);
	assert.equal((await n.api("agents/alpha/notebook", "PUT", { text: "x".repeat(64 * 1024 + 1) })).status, 413);
	assert.equal((await n.api("agents/alpha/notebook", "PUT", {})).status, 400);
	// Found by the phase 5 review: a save over a notebook that changed since the edit began would erase the new notes.
	const current = await (await n.api("agents/alpha/notebook", "GET")).json();
	assert.equal((await n.api("agents/alpha/notebook", "PUT", { text: "mine", base: "stale" })).status, 409);
	assert.deepEqual(await (await n.api("agents/alpha/notebook", "GET")).json(), current);
	assert.equal((await n.api("agents/alpha/notebook", "PUT", { text: "mine", base: current.text })).status, 200);
	assert.deepEqual(await (await n.api("agents/broken/notebook")).json(), { text: "" });
});

test("consult answers from a read-only copy of the other agent: its model, soul and notebook", async (t) => {
	const n = await startNotes(t);
	const desk = await n.desk("alpha");
	await n.api("agents/beta/notebook", "PUT", { text: "- beta keeps the keys\n" });
	await n.say(desk, "consult beta where are the keys?");
	assert.deepEqual(await n.results(desk), [['[consult Beta] Observed: beta read "where are the keys?"', false]]);
	const copy = n.requests.find((r) => r.model === "w2")!;
	assert.deepEqual(copy.tools, ["read_file", "fetch"], "it can't consult, delegate, remember or change anything");
	assert.match(copy.system, /You are Beta\.[\s\S]*<notebook>\n- beta keeps the keys\n<\/notebook>[\s\S]*Observed, Inferred, Unknown/);
	assert.doesNotMatch(copy.system, /You are Alpha/);
	assert.equal((await n.copies(desk)).length, 1);
	await n.say(desk, "consult beta again");
	assert.equal((await n.copies(desk)).length, 2, "each consult is a fresh copy");
	assert.equal((await n.state()).threads.length, 2, "a consult isn't a thread");

	for (const [ask, error] of [
		["consult alpha anything", "That's you."],
		["consult nobody anything", 'No agent "nobody". The team: alpha, beta, broken.'],
		["consult broken anything", 'Broken can\'t answer: unknown model alias "nope"'],
	]) {
		await n.say(desk, ask!);
		assert.deepEqual((await n.results(desk)).at(-1), [error, true]);
	}
});

test("a restart mid-consult finds the same copy and asks it once", async (t) => {
	const n = await startNotes(t);
	const desk = await n.desk("alpha");
	void n.say(desk, "consult beta slow question").catch(() => {});
	await until(() => n.requests.some((r) => r.model === "w2"));
	await n.restart();
	await until(async () => (await n.results(desk)).length > 0, 15_000);
	assert.equal(n.requests.filter((r) => r.lastUserText === "slow question").length, 2, "the interrupted request ran again");
	assert.deepEqual(await n.results(desk), [['[consult Beta] Observed: beta read "slow question"', false]]);
	const copies = await n.copies(desk);
	assert.equal(copies.length, 1);
	assert.deepEqual((await n.messages(copies[0]!.id)).filter((m) => m.role === "user").map(textOf), ["slow question"]);
});
