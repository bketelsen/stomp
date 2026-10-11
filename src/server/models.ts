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
import { backoff } from "./backoff.ts";
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

/**
 * The keyless OpenAI-compatible servers in stomp.yaml. A server's models are registered while its `/models` answers. One
 * that doesn't, at startup or when a request to it fails before any output, is unregistered and asked again in the
 * background (backoff.ts) until it answers. `changed` is called when one goes or comes back, so agents resolve their
 * models again; each change is logged once. Returns what stops the retries.
 */
export async function watchServers(models: MutableModels, config: Pick<StompConfig, "providers" | "models">, changed: () => void, firstMs?: number) {
	const watched = Object.entries(config.providers).map(([id, { baseUrl: url }]) => {
		const baseUrl = url.replace(/\/+$/, "");
		const custom = Object.fromEntries(Object.entries(config.models).filter(([, e]) => typeof e !== "string" && e.ref.startsWith(`${id}/`)));
		let up: boolean | undefined;
		let probing: Promise<void> | undefined;
		const probe = (): Promise<void> =>
			(probing ??= (async () => {
				try {
					const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const listed = ((await response.json()) as { data?: ServerModel[] }).data ?? [];
					retry.ok();
					models.setProvider(serverProvider(id, baseUrl, listed, () => void probe()));
					addCustomModels(models, custom);
					if (up === false) console.log(`[stomp] provider ${id}: ${baseUrl} is back`);
					if (up === false) changed();
					up = true;
				} catch (error) {
					retry.failed();
					if (up === false) return;
					models.deleteProvider(id);
					console.error(`[stomp] provider ${id}: ${baseUrl}/models unreachable (${(error as Error).message}); retrying in the background`);
					if (up) changed();
					up = false;
				}
			})().finally(() => (probing = undefined)));
		const retry = backoff(() => void probe(), firstMs);
		return { probe, retry };
	});
	await Promise.all(watched.map((server) => server.probe()));
	return () => {
		for (const server of watched) server.retry.stop();
	};
}

/** A server's models. A request that fails before any output calls `failed`, to ask the server whether it's still up. */
function serverProvider(id: string, baseUrl: string, listed: ServerModel[], failed: () => void): Provider {
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
	const api = openAICompletionsApi();
	const watch = (events: AssistantMessageEventStream) => {
		void events.result().then((m) => m.stopReason === "error" && m.content.length === 0 && failed(), () => undefined);
		return events;
	};
	return createProvider({
		id,
		name: `${id} (${baseUrl})`,
		baseUrl,
		// Always configured; the OpenAI SDK needs a non-empty key.
		auth: { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "none" }, source: "keyless" }) } },
		models,
		api: { ...api, stream: (m, c, o) => watch(api.stream(m, c, o)), streamSimple: (m, c, o) => watch(api.streamSimple(m, c, o)) },
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

/** The subscriptions, models the catalog doesn't know, and the servers in stomp.yaml, watched (see watchServers). */
export async function buildModels(config: StompConfig, credentials: CredentialStore, changed: () => void) {
	const models = createModels({ credentials });
	for (const make of Object.values(SUBSCRIPTIONS)) models.setProvider(make());
	// Servers' own custom models are added as each comes up.
	addCustomModels(models, config.models);
	const stop = await watchServers(models, config, changed);
	return { models, stop };
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
 * the next. A failure after output is the request's: pi-durable's retry starts again at the first link. A server that's
 * down isn't registered (see watchServers), so it's skipped until it's back. With no link registered, the request fails
 * with the first link's "Unknown provider".
 */
function fallbackProvider(models: Models, chains: Model<Api>[]): Provider {
	const each = (model: Model<Api>, request: (link: Model<Api>) => AssistantMessageEventStream) => {
		const refs = linksOf({ provider: FALLBACK, modelId: model.id });
		const live = refs.flatMap((ref) => models.getModel(ref.provider, ref.modelId) ?? []);
		const links = live.length ? live : [{ ...model, provider: refs[0]!.provider, id: refs[0]!.modelId }];
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
 * provider isn't registered (a server that's down) is skipped, but one must resolve.
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
