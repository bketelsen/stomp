// pi-ai Models: the subscription providers, OpenAI-compatible servers from stomp.yaml, models the catalog doesn't
// know, fallback models, and alias resolution.
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type CredentialStore,
	createAssistantMessageEventStream,
	type Model,
	type Models,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
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

/** An agent whose `model` is a list gets a model of this provider, its id the links' refs joined by " | ". */
export const FALLBACK = "fallback";
const LINK = " | ";

/** The models a ref stands for: a fallback model's links, else the ref itself. */
export const linksOf = (ref: ModelRef): ModelRef[] =>
	ref.provider !== FALLBACK
		? [ref]
		: ref.modelId.split(LINK).map((link) => {
				const [provider, modelId] = splitRef(link);
				return { provider, modelId: modelId! };
			});

/**
 * Each request goes to the first link whose provider is registered, and a link that fails before any output hands it to
 * the next. A failure after output is the request's: pi-durable's retry starts again at the first link. Nothing is
 * remembered, so a link that's down costs a refused connection per request, and it's used again once it's back.
 */
function fallbackProvider(models: Models, chains: Model<Api>[]): Provider {
	const each = (model: Model<Api>, request: (link: Model<Api>) => AssistantMessageEventStream) => {
		const links = linksOf({ provider: FALLBACK, modelId: model.id }).flatMap((ref) => models.getModel(ref.provider, ref.modelId) ?? []);
		const out = createAssistantMessageEventStream();
		void (async () => {
			for (const link of links) {
				const events = request(link);
				let start: AssistantMessageEvent | undefined;
				let output = false;
				for await (const event of events) {
					if (!output && event.type === "start") {
						start = event;
						continue;
					}
					if (!output && event.type === "error" && event.reason === "error" && link !== links.at(-1)) {
						console.error(`[stomp] ${link.provider}/${link.id}: ${event.error.errorMessage}; trying the next model`);
						break;
					}
					if (!output && start) out.push(start);
					output = true;
					out.push(event);
				}
				if (output) return out.end(await events.result());
			}
		})();
		return out;
	};
	return createProvider({
		id: FALLBACK,
		auth: { apiKey: { name: "none", resolve: async () => ({ auth: {}, source: "links" }) } },
		models: chains,
		api: {
			stream: (model, context, options) => each(model, (link) => models.stream(link, context, options)),
			streamSimple: (model, context, options) => each(model, (link) => models.streamSimple(link, context, options)),
		},
	});
}

/** An alias or `provider/modelId` as a ref, unchecked. */
function refOf(aliases: StompConfig["models"], spec: string): ModelRef | undefined {
	const entry = aliases[spec];
	const [provider, modelId] = splitRef(entry === undefined ? spec : typeof entry === "string" ? entry : entry.ref);
	return modelId === undefined ? undefined : { provider, modelId };
}

/**
 * An alias or `provider/modelId`, resolved to a model `models` knows, or why not. A list is a fallback model: a link whose
 * provider isn't registered (a server that was down at startup) is skipped, but one must resolve.
 */
export function resolveModel(models: MutableModels, aliases: StompConfig["models"], spec: string | readonly string[]): ModelRef | string {
	const refs: ModelRef[] = [];
	for (const one of typeof spec === "string" ? [spec] : spec) {
		const ref = refOf(aliases, one);
		if (ref === undefined) return `unknown model alias "${one}"`;
		refs.push(ref);
	}
	const problems = refs.map(({ provider, modelId }) =>
		models.getProvider(provider) === undefined
			? `provider "${provider}" is not configured or unreachable`
			: models.getModel(provider, modelId) === undefined
				? `provider "${provider}" has no model "${modelId}"`
				: undefined,
	);
	// A model its provider doesn't have is a typo, not an outage.
	const typo = problems.find((problem) => problem?.includes("has no model"));
	if (typo !== undefined) return typo;
	if (refs.length === 1 || problems.every(Boolean)) return problems[0] ?? refs[0]!;
	const live = refs.flatMap((ref) => models.getModel(ref.provider, ref.modelId) ?? []);
	const id = refs.map((ref) => `${ref.provider}/${ref.modelId}`).join(LINK);
	const chain: Model<Api> = {
		id,
		name: id,
		api: live[0]!.api,
		provider: FALLBACK,
		baseUrl: "",
		input: live[0]!.input,
		cost: live[0]!.cost,
		reasoning: live.some((m) => m.reasoning),
		// The smallest, so pi-durable compacts before any link overflows.
		contextWindow: Math.min(...live.map((m) => m.contextWindow)),
		maxTokens: Math.min(...live.map((m) => m.maxTokens)),
	};
	models.setProvider(fallbackProvider(models, [...models.getModels(FALLBACK).filter((m) => m.id !== id), chain]));
	return { provider: FALLBACK, modelId: id };
}
