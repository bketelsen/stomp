// Agent files: `agents/<id>.md`, YAML frontmatter then a body whose first H1 is the agent's name. A bad file gives
// that agent an `error`; it never stops the server.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { parse } from "yaml";
import { expandHome } from "./config.ts";
import { familyOf } from "./family.ts";
import { linksOf } from "./models.ts";

export type AgentConfig = {
	id: string;
	name: string;
	/** The frontmatter's `title`: a few words on what the agent is for, shown beside its name. */
	title?: string;
	/** As written in the file: an alias or `provider/modelId`, or a list of them, tried in order, joined by ", ". */
	model: string;
	provider: string;
	modelId: string;
	/** One per family in the model's list, in order. */
	families: string[];
	role: "agent" | "supervisor";
	thinking: ModelThinkingLevel;
	cwd: string;
	/** house.md, a blank line, then the body. */
	instructions: string;
	/** `$STOMP_STATE/notes/<id>.md`. */
	notebook: string;
	duties: Duty[];
	/** The MCP servers (stomp.yaml's `mcp`) whose tools this agent has. */
	mcp: string[];
	error?: string;
};

/**
 * A scheduled check: every `every` (`ms`), run `check`; wake the agent with `brief` when its result `changed`, it `failed`,
 * or `always`. Without a check, it wakes the agent every time. `added`: the supervisor's, from `$STOMP_STATE/duties.yaml`.
 */
export type Duty = { name: string; every: string; ms: number; check?: string; wake: "changed" | "failed" | "always"; brief: string; added?: true };

export type AgentContext = {
	resolveModel(spec: string | string[]): ModelRef | string;
	families: readonly [RegExp, string][];
	/** Default cwd parent: `$STOMP_STATE/scratch`. */
	scratch: string;
	/** Notebooks: `$STOMP_STATE/notes`. */
	notes: string;
	/** The duties the supervisor added: `$STOMP_STATE/duties.yaml`, a list per agent id. */
	duties: string;
	/** Why an agent can't have this MCP server's tools (unknown, or it didn't start), or undefined. */
	mcp(name: string): string | undefined;
};

const LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const WAKES: readonly string[] = ["changed", "failed", "always"];
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `file`: duties.yaml, whose duties are the supervisor's. */
export function parseDuties(raw: unknown, file?: string): Duty[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error(`${file ? `${file}: ` : ""}duties must be a list`);
	return raw.map((item: Record<string, unknown> | null, i) => {
		const duty = item ?? {};
		const where = `${file ? `${file}: ` : ""}duty ${typeof duty.name === "string" ? duty.name : i + 1}`;
		const text = (field: string) => {
			if (typeof duty[field] !== "string" || !duty[field].trim()) throw new Error(`${where}: ${field} is required`);
			return duty[field].trim();
		};
		const [name, every, brief] = [text("name"), text("every"), text("brief")];
		const check = duty.check === undefined ? undefined : text("check");
		const match = /^(\d+)([mhd])$/.exec(every);
		const ms = match ? Number(match[1]) * UNITS[match[2]!]! : 0;
		if (ms < 5 * 60_000) throw new Error(`${where}: every must be like 15m, 6h or 1d, and at least 5m`);
		const wake = duty.wake ?? (check === undefined ? "always" : "changed");
		if (!WAKES.includes(wake as string)) throw new Error(`${where}: wake must be one of ${WAKES.join(", ")}`);
		if (check === undefined && wake !== "always") throw new Error(`${where}: without a check, it can only wake every time`);
		return { name, every, ms, ...(check !== undefined && { check }), wake: wake as Duty["wake"], brief, ...(file !== undefined && { added: true as const }) };
	});
}

const WAKE_TEXT = { changed: "wakes when its result changes", failed: "wakes when it fails", always: "wakes every time" };

/** A duty as agents read it: their own in their instructions, the team's in the supervisor's team section. */
export const dutyText = (d: Duty): string => `${d.name}, every ${d.every}: ${d.check ? `runs \`${d.check}\`, ` : ""}${WAKE_TEXT[d.wake]}. Brief: ${d.brief}`;

/** duties.yaml, by agent id. Only the duty tool writes it, so a malformed file (a hand edit) is logged and skipped. */
function addedDuties(file: string): Record<string, unknown> {
	try {
		const all: unknown = parse(readOptional(file));
		return all !== null && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, unknown>) : {};
	} catch (error) {
		console.error(`[stomp] ${file}: ${(error as Error).message}`);
		return {};
	}
}

/** `added`: this agent's list in duties.yaml. */
export function parseAgent(id: string, text: string, house: string, context: AgentContext, added?: unknown): AgentConfig {
	const agent: AgentConfig = {
		id,
		name: id,
		model: "",
		provider: "",
		modelId: "",
		families: [],
		role: "agent",
		thinking: "medium",
		cwd: join(context.scratch, id),
		instructions: "",
		notebook: join(context.notes, `${id}.md`),
		duties: [],
		mcp: [],
	};
	try {
		const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
		if (!match) throw new Error("missing YAML frontmatter");
		const meta = (parse(match[1]!) ?? {}) as Record<string, unknown>;
		const body = match[2]!.trim();
		agent.name = /^#[ \t]+(.+)$/m.exec(body)?.[1]!.trim() ?? id;
		agent.instructions = house ? `${house}\n\n${body}` : body;
		const spec = Array.isArray(meta.model) ? meta.model.map(String) : typeof meta.model === "string" ? meta.model : "";
		agent.model = typeof spec === "string" ? spec : spec.join(", ");
		if (typeof meta.title === "string" && meta.title.trim()) agent.title = meta.title.trim();
		if (meta.role !== undefined && meta.role !== "agent" && meta.role !== "supervisor") {
			throw new Error(`role must be agent or supervisor, not "${meta.role}"`);
		}
		agent.role = (meta.role as AgentConfig["role"] | undefined) ?? "agent";
		if (meta.thinking !== undefined && !LEVELS.includes(String(meta.thinking))) {
			throw new Error(`thinking must be one of ${LEVELS.join(", ")}`);
		}
		agent.thinking = (meta.thinking as ModelThinkingLevel | undefined) ?? "medium";
		if (typeof meta.cwd === "string") agent.cwd = expandHome(meta.cwd);
		agent.duties = [...parseDuties(meta.duties), ...parseDuties(added, "duties.yaml")];
		const names = agent.duties.map((duty) => duty.name);
		const twice = names.find((name, i) => names.indexOf(name) !== i);
		if (twice !== undefined) throw new Error(`two duties are named ${twice}`);
		// Found in use: asked what duties they had, agents said "none", because the frontmatter never reached them.
		const listed = agent.duties.map((duty) => `- ${dutyText(duty)}`).join("\n");
		if (listed) agent.instructions += `\n\n## Your duties\nstomp runs these on their schedule and wakes you with the brief when one calls for it.\n${listed}`;
		if (meta.mcp !== undefined && !Array.isArray(meta.mcp)) throw new Error("mcp must be a list of servers from stomp.yaml");
		agent.mcp = ((meta.mcp ?? []) as unknown[]).map(String);
		const problem = agent.mcp.map((name) => context.mcp(name)).find(Boolean);
		if (problem) throw new Error(problem);
		if (!agent.model) throw new Error("model is required");
		const ref = context.resolveModel(spec);
		if (typeof ref === "string") throw new Error(ref);
		agent.provider = ref.provider;
		agent.modelId = ref.modelId;
		for (const { modelId } of linksOf(ref)) {
			const family = familyOf(modelId, context.families);
			if (family === undefined) throw new Error(`unknown family for model "${modelId}"; add it to families in stomp.yaml`);
			if (!agent.families.includes(family)) agent.families.push(family);
		}
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
	const added = addedDuties(context.duties);
	const dir = join(configDir, "agents");
	const files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
	const agents = files.map((file) => parseAgent(file.slice(0, -3), readOptional(join(dir, file)), house, context, added[file.slice(0, -3)]));
	const supervisor = agents.find((agent) => agent.role === "supervisor" && agent.error === undefined);
	for (const agent of agents) {
		if (agent.role === "supervisor" && agent.error === undefined && agent !== supervisor) {
			agent.error = `there can be only one supervisor, and it's ${supervisor!.id}`;
		}
	}
	return agents;
}
