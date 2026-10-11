import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { familyOf } from "../src/server/family.ts";
import { addCustomModels, FALLBACK, linksOf, resolveModel, watchServers } from "../src/server/models.ts";
import { until } from "./support/fixture.ts";
import { scriptedModels } from "./support/scripted.ts";

test("family from the model id, with extra rules first", () => {
	const cases: [string, string | undefined][] = [
		["claude-sonnet-5.5", "anthropic"],
		["us.anthropic.claude-opus-5", "anthropic"],
		["gpt-6.1-sol", "openai"],
		["o4-mini", "openai"],
		["gemini-3.8-flash", "google"],
		["halogen-qwen3.8-flash-next", "qwen"],
		["grok-4.7", "xai"],
		["kimi-k3", "moonshot"],
		["acme-code-1.1-flash", undefined],
	];
	for (const [id, family] of cases) assert.equal(familyOf(id), family, id);
	assert.equal(familyOf("qwen-coder", [[/coder/, "local"]]), "local");
});

test("aliases and provider/model refs resolve against the catalog, including models it doesn't know", () => {
	const models = createModels();
	models.setProvider(githubCopilotProvider());
	const aliases = {
		sonnet: "github-copilot/claude-sonnet-5.5",
		fresh: { ref: "github-copilot/new-model-id", api: "openai-responses", contextWindow: 123_000 },
	};
	addCustomModels(models, aliases);
	assert.deepEqual(resolveModel(models, aliases, "sonnet"), { provider: "github-copilot", modelId: "claude-sonnet-5.5" });
	assert.deepEqual(resolveModel(models, aliases, "github-copilot/gpt-6.1-sol"), { provider: "github-copilot", modelId: "gpt-6.1-sol" });
	assert.deepEqual(resolveModel(models, aliases, "fresh"), { provider: "github-copilot", modelId: "new-model-id" });
	const fresh = models.getModel("github-copilot", "new-model-id")!;
	assert.deepEqual([fresh.api, fresh.contextWindow, fresh.provider], ["openai-responses", 123_000, "github-copilot"]);
	assert.ok(models.getModel("github-copilot", "claude-sonnet-5.5"), "catalog models stay");
	assert.match(resolveModel(models, aliases, "nope") as string, /unknown model alias/);
	assert.match(resolveModel(models, aliases, "local/qwen") as string, /not configured/);
	assert.match(resolveModel(models, aliases, "github-copilot/gpt-99") as string, /no model "gpt-99"/);
});

test("a list is a fallback model: each request goes to the first link that answers", async (t) => {
	const down = new Set<string>();
	const models = scriptedModels((r) => (down.has(r.model) ? { error: `${r.model}: connect ECONNREFUSED` } : { text: `from ${r.model}` }), ["primary", "backup"]);
	// local isn't registered: a server that was down when stomp started.
	const ref = resolveModel(models, { qwen: "local/qwen3" }, ["scripted/primary", "qwen", "scripted/backup"]);
	assert.deepEqual(ref, { provider: FALLBACK, modelId: "scripted/primary | local/qwen3 | scripted/backup" });
	assert.deepEqual(linksOf(ref as { provider: string; modelId: string }).map((l) => l.provider), ["scripted", "local", "scripted"]);
	const model = models.getModel(FALLBACK, (ref as { modelId: string }).modelId)!;
	assert.equal(model.contextWindow, 200_000);
	const ask = () => models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	const logged = t.mock.method(console, "error", () => {});

	const first = await ask();
	assert.deepEqual([first.stopReason, first.provider, first.model, first.content], ["stop", "scripted", "primary", [{ type: "text", text: "from primary" }]]);
	down.add("primary");
	const second = await ask();
	assert.deepEqual([second.stopReason, second.model, second.content], ["stop", "backup", [{ type: "text", text: "from backup" }]]);
	assert.match(String(logged.mock.calls[0]!.arguments[0]), /scripted\/primary: primary: connect ECONNREFUSED; trying the next model/);
	down.add("backup");
	const third = await ask();
	assert.deepEqual([third.stopReason, third.model, third.errorMessage], ["error", "backup", "backup: connect ECONNREFUSED"]);
	down.clear();
	assert.equal((await ask()).model, "primary", "nothing is remembered: the primary answers again once it's back");

	assert.deepEqual(resolveModel(models, {}, ["scripted/backup"]), { provider: "scripted", modelId: "backup" });
	assert.match(resolveModel(models, {}, ["scripted/primary", "scripted/nope"]) as string, /no model "nope"/);
	assert.match(resolveModel(models, {}, ["local/a", "other/b"]) as string, /provider "local" is not configured/);
	assert.match(resolveModel(models, {}, ["scripted/primary", "nope"]) as string, /unknown model alias "nope"/);
});

/** An OpenAI-compatible server serving "qwen". While `down`, /models answers 503 and a completion's connection is dropped. */
async function fakeServer() {
	const chunk = (body: object) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "qwen", ...body })}\n\n`;
	const state = { down: true, url: "" };
	const server = createServer((req, res) => {
		if (state.down) return req.url?.endsWith("/models") ? res.writeHead(503).end() : req.socket.destroy();
		if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "qwen", context_length: 32_000 }] }));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "from qwen" }, finish_reason: null }] }));
		res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	return Object.assign(state, { close: () => server.close() });
}

test("a server that's down is retried in the background; while it's down the next model serves, and once it's back it's used again", async (t) => {
	const server = await fakeServer();
	t.after(server.close);
	const errors = t.mock.method(console, "error", () => {});
	const logs = t.mock.method(console, "log", () => {});
	const models = scriptedModels((r) => ({ text: `from ${r.model}` }), ["backup"]);
	let changes = 0;
	const stop = await watchServers(models, { providers: { local: { baseUrl: server.url } }, models: {} }, () => changes++, 10);
	t.after(stop);
	const said = (calls: typeof errors.mock.calls, pattern: RegExp) => calls.filter((c) => pattern.test(String(c.arguments[0]))).length;
	assert.equal(models.getProvider("local"), undefined, "down at startup: not registered");
	const ref = resolveModel(models, {}, ["local/qwen", "scripted/backup"]) as { provider: string; modelId: string };
	const model = models.getModel(FALLBACK, ref.modelId)!;
	const ask = () => models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	assert.equal((await ask()).model, "backup", "while it's down the next model serves");

	await sleep(100); // several retries, each failing
	assert.equal(said(errors.mock.calls, /unreachable/), 1, "a state change is logged once, not on every retry");
	server.down = false;
	await until(() => models.getProvider("local"));
	assert.equal(changes, 1, "coming back reloads agents");
	assert.equal(said(logs.mock.calls, /provider local: .* is back/), 1);
	const back = await ask();
	assert.deepEqual([back.provider, back.model, back.content], ["local", "qwen", [{ type: "text", text: "from qwen" }]]);

	// Failing mid-run: the request falls through to the next model, and the probe that follows finds the server down.
	server.down = true;
	assert.equal((await ask()).model, "backup");
	await until(() => models.getProvider("local") === undefined);
	await sleep(100);
	assert.deepEqual([changes, said(errors.mock.calls, /unreachable/)], [2, 2]);
	server.down = false;
	await until(() => models.getProvider("local"));
	assert.equal((await ask()).model, "qwen");
	assert.equal(changes, 3);
});
