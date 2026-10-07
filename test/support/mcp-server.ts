// A fake MCP server on stdio: a read-only tool, a destructive one, an unannotated one, and one that makes it exit.
// Every call that reaches it is a line in $FAKE_LOG.
import { appendFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake", version: "1.0.0" });
const reply = (text: string) => (appendFileSync(process.env.FAKE_LOG!, `${text}\n`), { content: [{ type: "text" as const, text }] });
const dataset = { dataset: z.string() };
// Named like stomp's own read tool, so it arrives as fake_read.
server.registerTool("read", { description: "Read a variable", inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } }, ({ name }) =>
	reply(`${name}=${process.env[name] ?? "(unset)"}`),
);
server.registerTool("wipe", { description: "Wipe a dataset", inputSchema: dataset, annotations: { destructiveHint: true } }, (args) => reply(`wiped ${args.dataset}`));
// Destructive when $FAKE_FLAG exists at startup: a server whose annotations change across a restart.
const tagged = existsSync(process.env.FAKE_FLAG ?? "") ? { annotations: { destructiveHint: true } } : {};
server.registerTool("tag", { description: "Tag a dataset", inputSchema: { ...dataset, label: z.string() }, ...tagged }, (args) => reply(`tagged ${args.dataset} ${args.label}`));
server.registerTool("exit", { description: "Stop the server", annotations: { readOnlyHint: true } }, () => process.exit(0));
await server.connect(new StdioServerTransport());
