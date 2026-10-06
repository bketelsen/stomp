import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { startStomp } from "../src/server/stomp.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { scriptedModels } from "./support/scripted.ts";

test("one desk per agent across restarts; agents answer and follow their files", async (t) => {
	const fx = fixture();
	fx.agent("alpha", agentFile("Alpha", "scripted/w1"));
	fx.agent("beta", agentFile("Beta", "scripted/w2", "thinking: high\n"));
	const models = scriptedModels(
		(r) => {
			if (r.toolResults > 0) return { text: "bash done" };
			if (r.lastUserText.startsWith("run ")) return { bash: r.lastUserText.slice(4) };
			return { text: `${r.model}: ${r.system.includes("You are Alpha.")}` };
		},
		["w1", "w2"],
	);
	const open = () => startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models });
	let stomp = await open();
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const before = await stomp.state();
	await stomp.close();
	stomp = await open();
	const state = await stomp.state();
	assert.deepEqual(state.agents.map((a) => [a.id, a.deskThread]), before.agents.map((a) => [a.id, a.deskThread]));
	assert.deepEqual(state.threads.map((t) => [t.agent, t.desk, t.title]), [["alpha", true, "Alpha"], ["beta", true, "Beta"]]);

	const alpha = (await stomp.harness.conversation(state.agents[0]!.deskThread as ConversationId, ctx))!;
	await (await alpha.submit({ type: "input", content: "run echo hi-there" }, ctx)).wait(ctx);
	const page = await alpha.entries({}, 10, undefined, ctx);
	const texts = page.items.map((e) => JSON.stringify(e.model ?? []));
	assert.match(texts[0]!, /bash done/);
	assert.ok(texts.some((t) => t.includes("hi-there\\n") && t.includes("toolResult")));
	await (await alpha.submit({ type: "input", content: "who?" }, ctx)).wait(ctx);
	assert.match(JSON.stringify((await alpha.entries({}, 1, undefined, ctx)).items[0]!.model), /w1: true/, "the soul is in the system prompt");

	// Editing a file reconfigures its threads; a new file gets a desk.
	fx.agent("alpha", agentFile("Alpha Prime", "scripted/w1"));
	fx.agent("gamma", agentFile("Gamma", "scripted/w2"));
	const reloaded = await until(async () => {
		const s = await stomp.state();
		const instructions = (await stomp.harness.snapshot(AgentDoc, alpha.id, ctx))!.instructions!;
		return s.agents.length === 3 && s.agents.every((a) => a.deskThread > 0) && instructions.includes("You are Alpha Prime.") && s;
	});
	assert.equal(reloaded.threads.find((thread) => thread.id === alpha.id)!.title, "Alpha Prime");
});
