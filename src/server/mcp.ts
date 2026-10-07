// MCP servers (stomp.yaml's `mcp`): one stdio process each, started with stomp and given the server's environment plus
// `env`, so secrets reach them and never agents' shells. Each is an extension, mcp-<name>, for the agents whose files
// list it: a tool per MCP tool, and the guard, which judges a call as the command
// `mcp <server> <tool> [--read-only|--destructive] '<args as JSON>'`, marked from the tool's annotations. Tools are
// named <server>_<tool> unless already so prefixed, so no two servers' tools share a name. A call that finds its server
// gone starts it again, once, and re-lists its tools; if that changed the tool's annotations, the call isn't made, so
// its retry is judged afresh. Secret values never come back in results or errors.
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type Extension, type HookRegistration } from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ContentBlock, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import type { StompConfig } from "./config.ts";

/** A guard's command for a call, or undefined for a call it doesn't judge. */
export type Judged = (name: string, args: Record<string, unknown>) => string | undefined;
type Server = { client?: Client; starting?: Promise<Client>; error?: string; extension: Extension; tools?: Map<string, Tool> };

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
};

export function stompMcp(config: StompConfig["mcp"], host: McpHost) {
	const servers = new Map(Object.keys(config).map((name): [string, Server] => [name, { extension: extensionOf(name, []) }]));

	/** One extension per tool list: its guard knows exactly its tools, so a phase's tools and guard agree. */
	function extensionOf(server: string, listed: Tool[]): Extension {
		const named = new Map(listed.map((t) => [t.name.startsWith(`${server}_`) ? t.name : `${server}_${t.name}`, t]));
		const judged: Judged = (name, args) => {
			const t = named.get(name);
			return t && `mcp ${server} ${t.name}${marker(t)} ${quote(JSON.stringify(args))}`;
		};
		const tools = [...named].map(([name, t]) => {
			const { $schema: _, ...schema } = t.inputSchema;
			const parameters = Type.Unsafe<Record<string, unknown>>(schema);
			return defineTool({ name, description: t.description ?? t.title ?? t.name, parameters, execute: (args, _api, c) => call(server, t, args, c) });
		});
		return defineExtension({ name: `mcp-${server}`, tools, hooks: [host.guard(judged)] }) as Extension;
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
		client.onclose = () => (server.client = undefined);
		try {
			const { command, args = [], env = {} } = config[name] ?? { command: "" };
			const environment = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((e): e is [string, string] => e[1] !== undefined));
			await client.connect(new StdioClientTransport({ command, args, env: environment }), { timeout: START_MS });
			let page = await client.listTools({}, { timeout: START_MS });
			const listed = [...page.tools];
			while (page.nextCursor) listed.push(...(page = await client.listTools({ cursor: page.nextCursor }, { timeout: START_MS })).tools);
			Object.assign(server, { client, error: undefined, tools: new Map(listed.map((t) => [t.name, t])), extension: extensionOf(name, listed) });
			host.install(server.extension);
			console.log(`[stomp] mcp: ${name} (${listed.length} tools)`);
			return client;
		} catch (error) {
			await client.close();
			server.error = (error as Error).message;
			console.error(`[stomp] mcp: ${name}: ${server.error}`);
			throw error;
		}
	}

	return {
		/** Level-triggered: start each server that isn't running. At startup, and when agent files change. */
		start: () => Promise.all([...servers.keys()].map((name) => running(name).catch(() => undefined))),
		extension: (name: string) => servers.get(name)!.extension,
		/** For agents' files: why an agent can't have this server, or undefined. */
		problem: (name: string) => (servers.has(name) ? servers.get(name)!.error && `MCP server ${name} didn't start: ${servers.get(name)!.error}` : `unknown MCP server "${name}"`),
		close: () => Promise.all([...servers.values()].map((server) => server.client?.close())),
	};
}
