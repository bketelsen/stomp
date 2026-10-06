// A deterministic scripted model on pi-ai's faux core: every request asks `responder` what to answer.
import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantMessage, JsonObject, Message, MutableModels, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export type Turn = { text?: string; bash?: string; calls?: [string, JsonObject][]; delayMs?: number; error?: string };
export type Request = { model: string; system: string; lastUserText: string; toolResults: number; lastTool?: string; tools: string[] };

const textOf = (message: Message | undefined): string => {
	const content = message?.content;
	if (content === undefined) return "";
	return typeof content === "string" ? content : content.map((c) => ("text" in c ? c.text : "")).join("");
};

function requestOf(context: TranscriptContext, model: string): Request {
	const system = context.messages
		.filter((m) => m.role === "system")
		.flatMap((m) => [textOf(m), ...Object.values(m.sections ?? {})])
		.join("\n");
	const rest = context.messages.filter((m) => m.role !== "system");
	const lastAssistant = rest.findLastIndex((m) => m.role === "assistant");
	const last = rest.at(-1);
	return {
		model,
		system,
		lastUserText: textOf(rest.findLast((m) => m.role === "user")),
		toolResults: lastAssistant < 0 ? 0 : rest.slice(lastAssistant + 1).filter((m) => m.role === "toolResult").length,
		...(last?.role === "toolResult" ? { lastTool: last.toolName } : {}),
		tools: context.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []).map((tool) => tool.name) : [])),
	};
}

/** Models with one provider, "scripted", serving `ids`. Safe for concurrent conversations. */
export function scriptedModels(responder: (request: Request) => Turn, ids = ["scripted-1"]): MutableModels {
	const core = createFauxCore({
		provider: "scripted",
		api: "scripted",
		models: ids.map((id) => ({ id, contextWindow: 200_000, maxTokens: 16_384 })),
	});
	const step = async (context: TranscriptContext, options: { signal?: AbortSignal } | undefined, _state: unknown, model: { id: string }) => {
		const turn = responder(requestOf(context, model.id));
		if (turn.delayMs) await sleep(turn.delayMs, undefined, { signal: options?.signal });
		options?.signal?.throwIfAborted();
		if (turn.error !== undefined) return fauxAssistantMessage([], { stopReason: "error", errorMessage: turn.error });
		const calls = turn.bash ? [["bash", { command: turn.bash }] as const] : (turn.calls ?? []);
		if (calls.length) return fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: "toolUse" });
		return fauxAssistantMessage([fauxText(turn.text ?? "")]) as AssistantMessage;
	};
	const models = createModels();
	models.setProvider(
		createProvider({
			id: "scripted",
			auth: { apiKey: { name: "none", resolve: async () => ({ auth: {}, source: "scripted" }) } },
			models: core.models,
			api: {
				// The faux core is a FIFO of steps: queue exactly one per request, right before it is taken.
				stream: (model, context, options) => (core.appendResponses([step]), core.stream(model, context, options)),
				streamSimple: (model, context, options) => (core.appendResponses([step]), core.streamSimple(model, context, options)),
			},
		}),
	);
	return models;
}
