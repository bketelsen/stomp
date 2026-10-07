// One process: one Harness over one SQLite file, the agent files, HTTP and the WebSocket bridge.
import { mkdirSync, watch } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, defineExtension, type Extension, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { StateSnapshot } from "../shared/protocol.ts";
import { type AgentConfig, loadAgents, readOptional } from "./agents.ts";
import { createAsks, stompGuard } from "./asks.ts";
import { hiddenEnv, stompCoding } from "./coding.ts";
import { loadConfig, type StompConfig } from "./config.ts";
import { stompConsult } from "./consult.ts";
import { FileCredentialStore } from "./credentials.ts";
import { delegationTask } from "./delegation.ts";
import { startDuties } from "./duties.ts";
import { familyOf } from "./family.ts";
import { type Api, HttpError, httpHandler } from "./http.ts";
import { drainInboxes } from "./inbox.ts";
import { createJudge, JEV_URL } from "./judge.ts";
import { stompMcp } from "./mcp.ts";
import { stopThread } from "./stop.ts";
import { buildModels, resolveModel, SUBSCRIPTIONS } from "./models.ts";
import { notebooks } from "./notebook.ts";
import { checkPool, reviewPool, stompReview } from "./review.ts";
import { watchState } from "./state.ts";
import { stompSupervisor } from "./supervisor.ts";
import { createThread, listThreads, syncThreads } from "./threads.ts";
import { workspaces, workspaceTool } from "./workspace.ts";
import { attachBridge } from "./ws.ts";

export type StompOptions = {
	configDir: string;
	stateDir: string;
	/** Overrides stomp.yaml's `listen`. Port 0 picks a free port. */
	listen?: string;
	/** Instead of the real providers (tests). */
	models?: MutableModels;
	webDir?: string;
	/** How often duties are checked for, and their clock (tests). */
	dutyClock?: { tickMs: number; now(): number };
};

export type Stomp = {
	url: string;
	harness: Harness;
	/** The review pool as provider/modelId; empty when review is off. */
	reviewers: string[];
	/** What judges commands the rules leave: Jev, the local model, both or neither. */
	judge: string;
	state(): Promise<StateSnapshot>;
	close(): Promise<void>;
};

const WEB_DIR = join(import.meta.dirname, "..", "..", "dist", "web");

/** The judge's local fallback: `judge.qwen` if set, else the first model of `providers.local`. */
function localJudge(config: StompConfig, models: MutableModels): { baseUrl: string; model: string } | undefined {
	if (config.judge.qwen) {
		const ref = resolveModel(models, config.models, config.judge.qwen);
		const baseUrl = typeof ref === "string" ? undefined : config.providers[ref.provider]?.baseUrl;
		if (typeof ref === "string" || baseUrl === undefined) {
			return void console.error(`[stomp] judge.qwen: ${typeof ref === "string" ? ref : `${ref.provider} isn't in providers`}`);
		}
		return { baseUrl, model: ref.modelId };
	}
	const model = models.getProvider("local") && models.getModels("local")[0]?.id;
	return config.providers.local && model ? { baseUrl: config.providers.local.baseUrl, model } : undefined;
}

export async function startStomp(options: StompOptions): Promise<Stomp> {
	const config = loadConfig(options.configDir);
	const scratch = join(options.stateDir, "scratch");
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	mkdirSync(join(options.configDir, "agents"), { recursive: true });
	const credentials = new FileCredentialStore(join(options.stateDir, "credentials.json"));
	const models = options.models ?? (await buildModels(config, credentials));
	const family = (modelId: string) => familyOf(modelId, config.families);
	const load = () =>
		loadAgents(options.configDir, {
			resolveModel: (spec) => resolveModel(models, config.models, spec),
			families: config.families,
			scratch,
			notes: join(options.stateDir, "notes"),
			mcp: (name) => mcp.problem(name),
		});
	const pool = reviewPool(config.review?.pool ?? [], (spec) => resolveModel(models, config.models, spec), family);
	const ws = workspaces(options.stateDir);
	const key = process.env.TYPESAFE_API_KEY?.trim();
	const qwen = localJudge(config, models);
	const judge = createJudge({
		configDir: options.configDir,
		stateDir: options.stateDir,
		local: config.judge.local,
		reversible: config.judge.reversible,
		...(key ? { jev: { url: process.env.STOMP_JEV_URL ?? JEV_URL, key } } : {}),
		...(qwen ? { qwen } : {}),
	});
	const asks = createAsks(judge, options.stateDir);
	const guard = stompGuard(judge, asks, () => harness);
	const coding = stompCoding(config.bash.timeoutSeconds, workspaceTool(ws), guard);
	// Late-bound to what's opened below; nothing runs a tool or a task before `harness.resume()`.
	const review =
		config.review &&
		stompReview({
			pool,
			rounds: config.review.rounds,
			repos: config.repos,
			bashTimeoutSeconds: config.bash.timeoutSeconds,
			guard,
			familyOf: family,
			harness: () => harness,
		});
	const delegation = delegationTask((id) => agents.find((a) => a.id === id)?.name ?? id, review ? review.reviewed : undefined);
	const supervisor = stompSupervisor({
		agents: () => agents,
		extensions: (agent) => extensions(agent),
		harness: () => harness,
		state: () => state.snapshot(),
		workspaces: ws,
		delegation,
	});
	const notes = notebooks(() => agents, () => state.changed());
	const consult = stompConsult({ agents: () => agents, guard });
	// What every agent has besides its role's tools: its notebook, and consults; and the MCP servers its file lists.
	const common = defineExtension({ name: "stomp-agent", tools: [...notes.tools, consult.tool], sections: [notes.section] }) as Extension;
	const extensions = (agent: AgentConfig) => [agent.role === "supervisor" ? supervisor : coding, common, ...agent.mcp.map(mcp.extension)];
	const registry = createRegistry();
	for (const extension of [coding, supervisor, common, consult.extension]) registry.install(extension);
	if (review) registry.install(review.extension);
	const mcp = stompMcp(config.mcp, {
		taken: new Set(registry.snapshot().tools().map(({ tool }) => tool.name)),
		timeoutMs: config.bash.timeoutSeconds * 1000,
		guard: (judged) => stompGuard(judge, asks, () => harness, judged),
		install: (extension) => registry.install(extension),
	});
	await mcp.start();
	let agents = load();
	if (config.review) checkPool(pool, agents);
	const storage = await openNodeSqliteStorage(join(options.stateDir, "stomp.sqlite"));
	// Agents' shells don't inherit the server's secrets.
	const shellEnv = hiddenEnv(options.stateDir);
	const env = (cwd: string | undefined) => new NodeExecutionEnv({ cwd: cwd ?? scratch, shellEnv });
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: ({ cwd }) => env(cwd),
			onReport: (error) => console.error("[stomp]", error),
		},
		ctx,
	);

	await syncThreads(harness, agents, extensions);
	const registered = models.getProviders().map((provider) => provider.id);
	const providerIds = [...new Set([...Object.keys(SUBSCRIPTIONS), ...Object.keys(config.providers), ...registered])];
	const state = await watchState(harness, () => agents, models, providerIds, asks, notes);
	const stopReviewing = review?.start(harness);
	harness.resume();
	const clock = options.dutyClock ?? { tickMs: 60_000, now: Date.now };
	const stopDuties = startDuties(harness, { agents: () => agents, extensions, delegation, env, ...clock });
	const stopDraining = drainInboxes(harness, async () => Object.keys(await listThreads(harness)).map(Number));
	const api: Api = {
		state: () => state.snapshot(),
		async thread(id, chatting = false) {
			const record = (await listThreads(harness))[id];
			const conversation = record && (await harness.conversation(id as ConversationId, ctx));
			if (!record || !conversation) throw new HttpError(404, `no thread ${id}`);
			const agent = agents.find((a) => a.id === record.agent);
			if (chatting && (agent === undefined || agent.error !== undefined)) {
				throw new HttpError(409, `${record.agent}: ${agent?.error ?? "no agent file"}`);
			}
			return conversation;
		},
		async newThread(id, title) {
			const agent = agents.find((a) => a.id === id);
			if (!agent) throw new HttpError(404, `no agent ${id}`);
			if (agent.error !== undefined) throw new HttpError(409, `${id}: ${agent.error}`);
			return createThread(harness, agent, extensions, title, false);
		},
		async stop(id) {
			await api.thread(id);
			await stopThread(harness, id, ctx);
		},
		answer(id, answer) {
			if (!asks.answer(id, answer)) throw new HttpError(404, `no ask ${id}`);
		},
		decisions: (limit) => judge.recent(limit),
		notebook(id, text) {
			const agent = agents.find((a) => a.id === id);
			if (agent === undefined) throw new HttpError(404, `no agent ${id}`);
			if (text !== undefined) notes.write(agent, text);
			return readOptional(agent.notebook);
		},
	};

	// Agent files and house.md: reload, then bring every thread in line. Serialized, so desks are created once.
	let reloading = Promise.resolve();
	let timer: NodeJS.Timeout | undefined;
	const reload = () => {
		reloading = reloading
			.then(async () => {
				await mcp.start();
				agents = load();
				await syncThreads(harness, agents, extensions);
				state.changed();
			})
			.catch((error: unknown) => console.error("[stomp] reload", error));
	};
	const changed = () => {
		clearTimeout(timer);
		timer = setTimeout(reload, 200);
	};
	const watchers = [
		watch(options.configDir, (_event, file) => file === "house.md" && changed()),
		watch(join(options.configDir, "agents"), (_event, file) => (file === null || file.endsWith(".md")) && changed()),
	];

	const server = createServer(httpHandler(api, options.webDir ?? WEB_DIR));
	const listen = options.listen ?? config.listen;
	const colon = listen.lastIndexOf(":");
	const host = listen.slice(0, colon).replace(/^\[|\]$/g, "") || "127.0.0.1";
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(listen.slice(colon + 1)), host, resolve);
	});
	const { port } = server.address() as AddressInfo;
	const wss = attachBridge(server, api, state);

	let closing: Promise<void> | undefined;
	return {
		url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
		harness,
		reviewers: config.review ? pool.map((m) => `${m.ref.provider}/${m.ref.modelId}`) : [],
		judge: judge.backends,
		state: api.state,
		close: () =>
			(closing ??= (async () => {
				clearTimeout(timer);
				for (const watcher of watchers) watcher.close();
				for (const ws of wss.clients) ws.terminate();
				wss.close();
				server.close();
				server.closeAllConnections();
				await reloading;
				state.close();
				stopDraining();
				stopReviewing?.();
				await stopDuties();
				await harness.close(ctx);
				await mcp.close();
			})()),
	};
}
