import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { startStomp } from "../src/server/stomp.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { scriptedModels } from "./support/scripted.ts";

// Found by the phase 1 cross-family review: a follow-up queued behind a run that fails must still be answered.
test("a follow-up queued behind a failed run is answered", async (t) => {
	const fx = fixture();
	fx.agent("alpha", agentFile("Alpha", "scripted/w1"));
	const models = scriptedModels(
		(r) => (r.lastUserText === "fail" ? { delayMs: 300, error: "400 invalid_request: forced" } : { text: `answered ${r.lastUserText}` }),
		["w1"],
	);
	const stomp = await startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models });
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const desk = (await stomp.state()).agents[0]!.deskThread as ConversationId;
	const thread = (await stomp.harness.conversation(desk, ctx))!;
	const failing = await thread.submit({ type: "input", content: "fail" }, ctx);
	const followUp = await thread.submit({ type: "input", content: "follow", whenBusy: "followUp" }, ctx);
	assert.equal((await failing.wait(ctx)).status, "unanswered");
	const settled = await until(async () => {
		const status = await followUp.status(ctx);
		return status.status === "done" ? status : undefined;
	}, 5_000);
	assert.equal(settled.status, "done");
});
