// stomp.yaml, and where config and state live.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

/** An alias target: `provider/modelId`, or a model the pi-ai catalog doesn't know. */
export type ModelEntry = string | { ref: string; api?: string; contextWindow?: number; maxTokens?: number };

export type StompConfig = {
	listen: string;
	/** OpenAI-compatible servers without auth; their model lists are fetched at startup. */
	providers: Record<string, { baseUrl: string }>;
	models: Record<string, ModelEntry>;
	/** Extra `regex → family` rules, tried before the built-in table. */
	families: [RegExp, string][];
	bash: { timeoutSeconds: number };
	/** Cross-family review: models by alias or `provider/modelId`, and the automatic fix rounds. Absent: review is off. */
	review?: { pool: string[]; rounds: number };
	/** Per repo ("owner/name" or an absolute path): the command reviewers are told runs its tests. */
	repos: Record<string, { test?: string }>;
	/** The judge's routing bars, and the model alias its local fallback uses instead of `providers.local`'s first. */
	judge: { local: number; reversible: number; qwen?: string };
	/** MCP servers by name: each a stdio process with the server's environment plus `env`. */
	mcp: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
};

export const configDir = (): string => process.env.STOMP_CONFIG ?? join(homedir(), ".config", "stomp");
export const stateDir = (): string => process.env.STOMP_STATE ?? join(homedir(), ".local", "share", "stomp");

export const expandHome = (path: string): string => (path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path);

/** A missing stomp.yaml means defaults. A malformed one throws: the server can't start without it. */
export function loadConfig(dir: string): StompConfig {
	let raw: {
		listen?: string;
		providers?: StompConfig["providers"];
		models?: StompConfig["models"];
		families?: Record<string, string>;
		bash?: { timeoutSeconds?: number };
		review?: { pool?: string[]; rounds?: number };
		repos?: StompConfig["repos"];
		judge?: Partial<StompConfig["judge"]>;
		mcp?: StompConfig["mcp"];
	} = {};
	try {
		raw = parse(readFileSync(join(dir, "stomp.yaml"), "utf8")) ?? {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`stomp.yaml: ${(error as Error).message}`);
	}
	return {
		listen: raw.listen ?? "127.0.0.1:7310",
		providers: raw.providers ?? {},
		models: raw.models ?? {},
		families: Object.entries(raw.families ?? {}).map(([pattern, family]) => [new RegExp(pattern, "i"), family]),
		bash: { timeoutSeconds: raw.bash?.timeoutSeconds ?? 600 },
		...(raw.review?.pool?.length ? { review: { pool: raw.review.pool, rounds: raw.review.rounds ?? 2 } } : {}),
		repos: raw.repos ?? {},
		judge: { local: raw.judge?.local ?? 0.7, reversible: raw.judge?.reversible ?? 0.85, ...(raw.judge?.qwen ? { qwen: raw.judge.qwen } : {}) },
		mcp: raw.mcp ?? {},
	};
}
