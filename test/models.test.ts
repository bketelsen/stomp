import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { familyOf } from "../src/server/family.ts";
import { addCustomModels, resolveModel } from "../src/server/models.ts";

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
