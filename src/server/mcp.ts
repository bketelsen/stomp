// MCP servers (stomp.yaml's `mcp`): one stdio process each, started with stomp and given the server's environment plus
// `env`, so secrets reach them and never agents' shells. Each is an extension, mcp-<name>, for the agents whose files
// list it: a tool per MCP tool, and the guard, which judges a call as the command
// `mcp <server> <tool> [--read-only|--destructive] '<args as JSON>'`, marked from the tool's annotations. Tools are
// named <server>_<tool> unless already so prefixed, so no two servers' tools share a name. A server that fails to start
// or goes away is down: its extension has no tools, only a line saying it's unavailable and why, so its agents carry on
// without it and can say so. It tries again on its own, after 1s, doubling to 5 minutes; its tools are back on the next
// turn once it's up. A call already made when it went starts it again, once, and re-lists its tools; if that changed the
// tool's annotations, the call isn't made, so its retry is judged afresh. Secret values never come back in results or
// errors.
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type Extension, type HookRegistration, section } from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ContentBlock, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { type Backoff, backoff } from "./backoff.ts";
import type { StompConfig } from "./config.ts";

/** A guard's command for a call, with where it runs when that isn't the caller's cwd; undefined for a call it doesn't judge. */
export type Judged = (name: string, args: Record<string, unknown>) => string | { command: string; cwd: string } | undefined;
type Server = { client?: Client; starting?: Promise<Client>; error?: string; extension: Extension; tools?: Map<string, Tool>; retry: Backoff };

const CAP = 50_000;
const START_MS = 15_000;
const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
const marker = ({ annotations: a }: Tool) => (a?.readOnlyHint === true ? " --read-only" : a?.destructiveHint === true ? " --destructive" : "");
/** Text as it is; an image, audio or resource as one line that names it. */
const textOf = (content: ContentBlock[]) =>
	content.map((c) => (c.type === "text" ? c.text : `[${c.type} ${c.type === "resource" ? c.resource.uri : c.type === "resource_link" ? c.uri : c.mimeType}]`)).join("\n");

export type McpHost = {
	/** Text with every secret value replaced. */
	redact(text: string): string;
	/** How long a call may take: bash's timeout. */
	timeoutMs: number;
	guard(judged: Judged): HookRegistration;
	/** Into the registry, in place of the server's previous extension. */
	install(extension: Extension): void;
	/** A server came up or went down: what `down` says changed. */
	changed(): void;
};

export function stompMcp(config: StompConfig["mcp"], host: McpHost) {
	const servers = new Map(
		Object.keys(config).map((name): [string, Server] => [name, { extension: extensionOf(name, []), retry: backoff(() => void running(name).catch(() => undefined)) }]),
	);
	for (const server of servers.values()) host.install(server.extension);
	let closed = false;

	/** One extension per tool list: its guard knows exactly its tools, so a phase's tools and guard agree. */
	function extensionOf(server: string, listed: Tool[]): Extension {
		const named = new Map<string, Tool>();
		for (const t of listed) {
			let name = t.name.startsWith(`${server}_`) ? t.name : `${server}_${t.name}`;
			while (named.has(name)) name += "_"; // a server listing both x and <server>_x keeps both
			named.set(name, t);
		}
		const judged: Judged = (name, args) => {
			const t = named.get(name);
			return t && `mcp ${server} ${t.name}${marker(t)} ${quote(JSON.stringify(args))}`;
		};
		const tools = [...named].map(([name, t]) => {
			const { $schema: _, ...schema } = t.inputSchema;
			const parameters = Type.Unsafe<Record<string, unknown>>(schema);
			return defineTool({ name, description: t.description ?? t.title ?? t.name, parameters, execute: (args, _api, c) => call(server, t, args, c) });
		});
		// Rendered each turn: a line while it's down, nothing once it's up.
		const error = () => servers.get(server)!.error;
		const unavailable = section(`mcp-${server}`, () => error() && `MCP server ${server} is unavailable (${error()}), so its tools are missing; stomp keeps retrying, and they're back once it's up.`, { tag: false });
		return defineExtension({ name: `mcp-${server}`, tools, sections: [unavailable], hooks: [host.guard(judged)] }) as Extension;
	}

	async function call(server: string, judged: Tool, args: Record<string, unknown>, c: Context) {
		try {
			const client = await running(server);
			const fresh = servers.get(server)!.tools?.get(judged.name);
			if (fresh === undefined || marker(fresh) !== marker(judged)) return reply(`mcp ${server}: ${judged.name} changed when the server restarted; call it again`, true);
			const result = await client.callTool({ name: judged.name, arguments: args }, undefined, { timeout: host.timeoutMs, signal: c.abortSignal });
			const text = host.redact(textOf((result.content ?? []) as ContentBlock[]));
			return reply(text.length > CAP ? `${text.slice(0, CAP)}\n[cut: ${text.length - CAP} more characters]` : text, result.isError === true);
		} catch (error) {
			c.abortSignal?.throwIfAborted();
			return reply(host.redact(`mcp ${server}: ${(error as Error).message}`), true);
		}
	}

	/** The server's client; if it's gone, start it again, once for this call and any that find it gone too. */
	async function running(name: string): Promise<Client> {
		const server = servers.get(name)!;
		return server.client ?? (server.starting ??= connect(name, server).finally(() => (server.starting = undefined)));
	}

	async function connect(name: string, server: Server): Promise<Client> {
		const client = new Client({ name: "stomp", version: "1.0.0" });
		// A running server that goes away is down until it's back: its agents lose its tools now, not when a restart fails.
		client.onclose = () => {
			if (server.client !== client || closed) return;
			server.client = undefined;
			lost(name, server, "it disconnected");
		};
		try {
			const { command, args = [], env = {} } = config[name] ?? { command: "" };
			const environment = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => e[1] !== undefined));
			await client.connect(new StdioClientTransport({ command, args, env: environment }), { timeout: START_MS });
			let page = await client.listTools({}, { timeout: START_MS });
			const listed = [...page.tools];
			while (page.nextCursor) listed.push(...(page = await client.listTools({ cursor: page.nextCursor }, { timeout: START_MS })).tools);
			const was = server.error;
			server.retry.ok();
			Object.assign(server, { client, error: undefined, tools: new Map(listed.map((t) => [t.name, t])), extension: extensionOf(name, listed) });
			host.install(server.extension);
			console.log(`[stomp] mcp: ${name} (${listed.length} tools)`);
			if (was !== undefined) host.changed();
			return client;
		} catch (error) {
			await client.close();
			lost(name, server, (error as Error).message);
			throw error;
		}
	}

	/** Down: its extension without tools (its line says why), the UI told, and another start set for later. */
	function lost(name: string, server: Server, reason: string) {
		const was = server.error;
		server.error = host.redact(reason);
		console.error(`[stomp] mcp: ${name}: ${server.error}`);
		if (server.extension.tools?.length) host.install((server.extension = extensionOf(name, [])));
		server.retry.failed();
		if (server.error !== was) host.changed();
	}

	return {
		/** Level-triggered: start each server that isn't running or waiting to retry. At startup, and when agent files change. */
		start: () => Promise.all([...servers].filter(([, s]) => !s.retry.waiting).map(([name]) => running(name).catch(() => undefined))),
		extension: (name: string) => servers.get(name)!.extension,
		/** For agents' files: why an agent can't list this server (it isn't in stomp.yaml), or undefined. */
		problem: (name: string) => (servers.has(name) ? undefined : `unknown MCP server "${name}"`),
		/** Why the server's tools are missing now, or undefined while it's up (or yet to start). */
		down: (name: string) => servers.get(name)?.error && `MCP server ${name} is unavailable (${servers.get(name)!.error}); retrying`,
		close: () => {
			closed = true;
			for (const server of servers.values()) server.retry.stop();
			return Promise.all([...servers.values()].map((server) => server.client?.close()));
		},
	};
}
