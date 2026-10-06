// pi-ai Models: the subscription providers, OpenAI-compatible servers from stomp.yaml, models the catalog doesn't
// know, and alias resolution.
import type { Api, CredentialStore, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { StompConfig } from "./config.ts";

/** `openai` is "Sign in with ChatGPT"; `openai-codex` is the legacy route. */
export const SUBSCRIPTIONS = {
	"github-copilot": githubCopilotProvider,
	openai: openaiProvider,
	"openai-codex": openaiCodexProvider,
	anthropic: anthropicProvider,
} as const;
export type Subscription = keyof typeof SUBSCRIPTIONS;

type ServerModel = { id: string; context_length?: number; max_model_len?: number; max_tokens_default?: number };

/** A keyless OpenAI-compatible server, its models fetched now. Undefined (with a warning) when it's unreachable. */
export async function openAICompatibleProvider(id: string, url: string): Promise<Provider | undefined> {
	const baseUrl = url.replace(/\/+$/, "");
	let listed: ServerModel[];
	try {
		const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		listed = ((await response.json()) as { data?: ServerModel[] }).data ?? [];
	} catch (error) {
		console.error(`[stomp] provider ${id}: ${baseUrl}/models unreachable (${(error as Error).message})`);
		return undefined;
	}
	const models: Model<"openai-completions">[] = listed.map((m) => ({
		id: m.id,
		name: m.id,
		api: "openai-completions",
		provider: id,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.context_length ?? m.max_model_len ?? 131_072,
		maxTokens: m.max_tokens_default ?? 8192,
		// pi-ai guesses compat from the URL and treats an unknown LAN URL like api.openai.com.
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsUsageInStreaming: true,
		},
	}));
	return createProvider({
		id,
		name: `${id} (${baseUrl})`,
		baseUrl,
		// Always configured; the OpenAI SDK needs a non-empty key.
		auth: { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "none" }, source: "keyless" }) } },
		models,
		api: openAICompletionsApi(),
	});
}

/** Add models the catalog doesn't know, cloned from a catalog model of the same provider and api. */
export function addCustomModels(models: MutableModels, entries: StompConfig["models"]): void {
	const extra = new Map<string, Model<Api>[]>();
	for (const entry of Object.values(entries)) {
		if (typeof entry === "string") continue;
		const [providerId, modelId] = splitRef(entry.ref);
		const catalog = models.getModels(providerId);
		const template = catalog.find((m) => m.api === entry.api) ?? catalog[0];
		if (modelId === undefined || template === undefined) continue;
		const model = { ...template, id: modelId, name: modelId, api: entry.api ?? template.api };
		if (entry.contextWindow !== undefined) model.contextWindow = entry.contextWindow;
		if (entry.maxTokens !== undefined) model.maxTokens = entry.maxTokens;
		extra.set(providerId, [...(extra.get(providerId) ?? []), model]);
	}
	for (const [providerId, added] of extra) {
		const base = models.getProvider(providerId)!;
		const merge = <M extends { id: string }>(list: readonly M[]) => [
			...list.filter((m) => !added.some((a) => a.id === m.id)),
			...added,
		];
		models.setProvider({
			...base,
			getModels: () => merge(base.getModels()),
			getAllModels: () => merge(base.getAllModels?.() ?? base.getModels()),
		} as Provider);
	}
}

export async function buildModels(config: StompConfig, credentials: CredentialStore): Promise<MutableModels> {
	const models = createModels({ credentials });
	for (const make of Object.values(SUBSCRIPTIONS)) models.setProvider(make());
	for (const [id, { baseUrl }] of Object.entries(config.providers)) {
		const provider = await openAICompatibleProvider(id, baseUrl);
		if (provider) models.setProvider(provider);
	}
	addCustomModels(models, config.models);
	return models;
}

function splitRef(ref: string): [string, string | undefined] {
	const slash = ref.indexOf("/");
	return slash < 0 ? [ref, undefined] : [ref.slice(0, slash), ref.slice(slash + 1)];
}

/** An alias or `provider/modelId`, resolved to a model `models` knows, or why not. */
export function resolveModel(models: MutableModels, aliases: StompConfig["models"], spec: string): ModelRef | string {
	const entry = aliases[spec];
	const [provider, modelId] = splitRef(entry === undefined ? spec : typeof entry === "string" ? entry : entry.ref);
	if (modelId === undefined) return `unknown model alias "${spec}"`;
	if (models.getProvider(provider) === undefined) return `provider "${provider}" is not configured or unreachable`;
	if (models.getModel(provider, modelId) === undefined) return `provider "${provider}" has no model "${modelId}"`;
	return { provider, modelId };
}
