// Agent files: `agents/<id>.md`, YAML frontmatter then a body whose first H1 is the agent's name. A bad file gives
// that agent an `error`; it never stops the server.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { parse } from "yaml";
import { expandHome } from "./config.ts";
import { familyOf } from "./family.ts";

export type AgentConfig = {
	id: string;
	name: string;
	/** As written in the file: an alias or `provider/modelId`. */
	model: string;
	provider: string;
	modelId: string;
	family: string;
	role: "agent" | "supervisor";
	thinking: ModelThinkingLevel;
	cwd: string;
	/** house.md, a blank line, then the body. */
	instructions: string;
	/** `$STOMP_STATE/notes/<id>.md`. */
	notebook: string;
	duties: Duty[];
	error?: string;
};

/** A scheduled check: every `every` (`ms`), run `check`; wake the agent with `brief` when its result `changed`, it `failed`, or `always`. */
export type Duty = { name: string; every: string; ms: number; check: string; wake: "changed" | "failed" | "always"; brief: string };

export type AgentContext = {
	resolveModel(spec: string): ModelRef | string;
	families: readonly [RegExp, string][];
	/** Default cwd parent: `$STOMP_STATE/scratch`. */
	scratch: string;
	/** Notebooks: `$STOMP_STATE/notes`. */
	notes: string;
};

const LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const WAKES: readonly string[] = ["changed", "failed", "always"];
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDuties(raw: unknown): Duty[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error("duties must be a list");
	const names = new Set<string>();
	return raw.map((item: Record<string, unknown> | null, i) => {
		const duty = item ?? {};
		const where = `duty ${typeof duty.name === "string" ? duty.name : i + 1}`;
		const text = (field: string) => {
			if (typeof duty[field] !== "string" || !duty[field].trim()) throw new Error(`${where}: ${field} is required`);
			return duty[field].trim();
		};
		const [name, every, check, brief] = [text("name"), text("every"), text("check"), text("brief")];
		const match = /^(\d+)([mhd])$/.exec(every);
		const ms = match ? Number(match[1]) * UNITS[match[2]!]! : 0;
		if (ms < 5 * 60_000) throw new Error(`${where}: every must be like 15m, 6h or 1d, and at least 5m`);
		const wake = duty.wake ?? "changed";
		if (!WAKES.includes(wake as string)) throw new Error(`${where}: wake must be one of ${WAKES.join(", ")}`);
		if (names.has(name)) throw new Error(`${where}: two duties have this name`);
		names.add(name);
		return { name, every, ms, check, wake: wake as Duty["wake"], brief };
	});
}

export function parseAgent(id: string, text: string, house: string, context: AgentContext): AgentConfig {
	const agent: AgentConfig = {
		id,
		name: id,
		model: "",
		provider: "",
		modelId: "",
		family: "unknown",
		role: "agent",
		thinking: "medium",
		cwd: join(context.scratch, id),
		instructions: "",
		notebook: join(context.notes, `${id}.md`),
		duties: [],
	};
	try {
		const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
		if (!match) throw new Error("missing YAML frontmatter");
		const meta = (parse(match[1]!) ?? {}) as Record<string, unknown>;
		const body = match[2]!.trim();
		agent.name = /^#[ \t]+(.+)$/m.exec(body)?.[1]!.trim() ?? id;
		agent.instructions = house ? `${house}\n\n${body}` : body;
		agent.model = typeof meta.model === "string" ? meta.model : "";
		if (meta.role !== undefined && meta.role !== "agent" && meta.role !== "supervisor") {
			throw new Error(`role must be agent or supervisor, not "${meta.role}"`);
		}
		agent.role = (meta.role as AgentConfig["role"] | undefined) ?? "agent";
		if (meta.thinking !== undefined && !LEVELS.includes(String(meta.thinking))) {
			throw new Error(`thinking must be one of ${LEVELS.join(", ")}`);
		}
		agent.thinking = (meta.thinking as ModelThinkingLevel | undefined) ?? "medium";
		if (typeof meta.cwd === "string") agent.cwd = expandHome(meta.cwd);
		agent.duties = parseDuties(meta.duties);
		if (!agent.model) throw new Error("model is required");
		const ref = context.resolveModel(agent.model);
		if (typeof ref === "string") throw new Error(ref);
		agent.provider = ref.provider;
		agent.modelId = ref.modelId;
		const family = familyOf(ref.modelId, context.families);
		if (family === undefined) throw new Error(`unknown family for model "${ref.modelId}"; add it to families in stomp.yaml`);
		agent.family = family;
		mkdirSync(agent.cwd, { recursive: true });
	} catch (error) {
		agent.error = (error as Error).message;
	}
	return agent;
}

export const readOptional = (file: string): string => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
};

/**
 * The notebook section's text, read from the file each time: an unchanged file renders the same text, so pi-durable
 * doesn't re-send it. Empty, it's still there, so a first note patches it in place instead of reordering the prompt.
 */
export const notebookText = (agent: AgentConfig): string => readOptional(agent.notebook).trim() || "(empty)";

/** Every agent file, sorted by id. Only the first valid supervisor keeps the role; later ones get an error. */
export function loadAgents(configDir: string, context: AgentContext): AgentConfig[] {
	const house = readOptional(join(configDir, "house.md")).trim();
	const dir = join(configDir, "agents");
	const files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
	const agents = files.map((file) => parseAgent(file.slice(0, -3), readOptional(join(dir, file)), house, context));
	const supervisor = agents.find((agent) => agent.role === "supervisor" && agent.error === undefined);
	for (const agent of agents) {
		if (agent.role === "supervisor" && agent.error === undefined && agent !== supervisor) {
			agent.error = `there can be only one supervisor, and it's ${supervisor!.id}`;
		}
	}
	return agents;
}
