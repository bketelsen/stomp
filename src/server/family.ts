// Model family from the model id alone: pi-ai has no vendor field. Claude through Copilot is still anthropic.

const BUILTIN: [RegExp, string][] = [
	[/claude|fable/, "anthropic"],
	[/^(gpt|o\d|codex)/, "openai"],
	[/gemini|gemma/, "google"],
	[/qwen/, "qwen"],
	[/grok/, "xai"],
	[/kimi|^k\d/, "moonshot"],
];

/** Lowercased, without `~`, `vendor/` prefixes and Bedrock-style `us.anthropic.` prefixes. */
export function normalizeModelId(modelId: string): string {
	let id = modelId.trim().toLowerCase().replace(/^~+/, "");
	id = id.slice(id.lastIndexOf("/") + 1);
	while (/^(us|eu|apac|ap|global|us-gov|jp|au|ca)\./.test(id)) id = id.slice(id.indexOf(".") + 1);
	return id.replace(/^(anthropic|openai|google|meta|amazon|mistral|qwen|xai|moonshot|moonshotai)\./, "");
}

/** `extra` (stomp.yaml `families`) is tried first. Undefined when no rule matches. */
export function familyOf(modelId: string, extra: readonly [RegExp, string][] = []): string | undefined {
	const id = normalizeModelId(modelId);
	return [...extra, ...BUILTIN].find(([pattern]) => pattern.test(id))?.[1];
}
