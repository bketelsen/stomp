// stomp-coding: read, write, edit, bash and workspace for every agent, and the guard. The guard is in stomp-review
// too: hooks run only where their extension is selected, so bash and its guard travel together.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool, type Extension, type HookRegistration, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";

/** pi-durable's bash has no default timeout; this one does. */
export function bashWithTimeout(seconds: number) {
	const bash = createBashTool();
	return defineTool({
		...bash,
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default ${seconds})` })),
		}),
		execute: (args, api, context) => bash.execute({ ...args, timeout: args.timeout ?? seconds }, api, context),
	});
}

/**
 * For agents' shells, over the server's environment: the judge's key and every secret in $STOMP_STATE/env, unset.
 * (Node's spawn leaves out variables whose value is undefined.)
 */
export function hiddenEnv(stateDir: string): NodeJS.ProcessEnv {
	let secrets = "";
	try {
		secrets = readFileSync(join(stateDir, "env"), "utf8");
	} catch {}
	const names = [...secrets.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=/gm)].map((match) => match[1]!);
	return Object.fromEntries(["TYPESAFE_API_KEY", ...names].map((name) => [name, undefined]));
}

export const stompCoding = (bashTimeoutSeconds: number, workspace: ToolRegistration, guard: HookRegistration): Extension =>
	defineExtension({
		name: "stomp-coding",
		tools: [createReadTool(), createWriteTool(), createEditTool(), bashWithTimeout(bashTimeoutSeconds), workspace],
		hooks: [guard],
	}) as Extension;
