// Subscription logins into $STOMP_STATE/credentials.json. Prints URLs and device codes to open yourself and reads
// pasted input from stdin. Never prints tokens.
//   npm run login <github-copilot|openai|openai-codex|anthropic>
//   npm run login -- --status
//   npm run login -- --logout <provider>
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { stateDir } from "./config.ts";
import { deviceId, FileCredentialStore } from "./credentials.ts";
import { SUBSCRIPTIONS, type Subscription } from "./models.ts";

const providers = Object.keys(SUBSCRIPTIONS) as Subscription[];
const [command, arg] = process.argv.slice(2);
if (command !== "--status" && !(command === "--logout" && arg) && !providers.includes(command as Subscription)) {
	console.error(`usage: npm run login <${providers.join("|")}>\n       npm run login -- --status | --logout <provider>`);
	process.exit(2);
}
const store = new FileCredentialStore(join(stateDir(), "credentials.json"));

if (command === "--status") {
	const stored = await store.load();
	console.log(`credentials: ${store.file}`);
	for (const id of providers) {
		const c = stored[id];
		const expiry = c?.type === "oauth" ? ` (token ${c.expires > Date.now() ? "valid" : "expired; refreshed on use"})` : "";
		console.log(`  ${id}: ${c ? `${c.type}${expiry}` : "not logged in"}`);
	}
	process.exit(0);
}
if (command === "--logout" && arg !== undefined) {
	await store.delete(arg);
	console.log(`removed credentials for ${arg}`);
	process.exit(0);
}
const providerId = command as Subscription;

const controller = new AbortController();
process.on("SIGINT", () => controller.abort(new Error("cancelled")));

// One readline for the whole flow; a prompt takes the next line unless its signal aborts first (e.g. the OAuth
// callback server won the race against a pasted redirect URL).
const queued: string[] = [];
let waiter: ((line: string) => void) | undefined;
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => (waiter ? waiter(line) : queued.push(line)));
const readLine = (signal: AbortSignal) =>
	new Promise<string>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const line = queued.shift();
		if (line !== undefined) return resolve(line);
		const onAbort = () => {
			waiter = undefined;
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		waiter = (next) => {
			waiter = undefined;
			signal.removeEventListener("abort", onAbort);
			resolve(next);
		};
	});

const interaction: AuthInteraction = {
	signal: controller.signal,
	async prompt(prompt) {
		const signal = prompt.signal ? AbortSignal.any([prompt.signal, controller.signal]) : controller.signal;
		if (prompt.type === "select") {
			console.log(`\n${prompt.message}`);
			prompt.options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${o.description ? ` - ${o.description}` : ""}`));
			process.stdout.write("choice [1]: ");
			const answer = (await readLine(signal)).trim();
			const chosen =
				answer === "" ? prompt.options[0] : (prompt.options[Number(answer) - 1] ?? prompt.options.find((o) => o.id === answer));
			if (!chosen) throw new Error(`invalid choice: ${answer}`);
			return chosen.id;
		}
		process.stdout.write(`\n${prompt.message}${prompt.placeholder ? ` (e.g. ${prompt.placeholder})` : ""}\n> `);
		return (await readLine(signal)).trim();
	},
	notify(event) {
		if (event.type === "auth_url") console.log(`\nOpen this URL in a browser:\n  ${event.url}\n${event.instructions ?? ""}`);
		else if (event.type === "device_code") console.log(`\nOpen ${event.verificationUri} and enter code: ${event.userCode}`);
		else if (event.type === "info") {
			console.log([event.message, ...(event.links ?? []).map((l) => `  ${l.label ?? ""} ${l.url}`)].join("\n"));
		}
		else if (event.type === "progress") console.log(`... ${event.message}`);
	},
};

const models = createModels({ credentials: store });
models.setProvider(SUBSCRIPTIONS[providerId]());
console.log(`logging in to ${providerId}; Ctrl-C to cancel`);
try {
	await models.login(providerId, "oauth", interaction, { getDeviceId: () => deviceId(stateDir()) });
	console.log(`saved credentials for ${providerId}`);
} catch (error) {
	console.error(`login failed for ${providerId}: ${controller.signal.aborted ? "cancelled" : (error as Error).message}`);
	process.exitCode = 1;
} finally {
	rl.close();
}
// Pending device-code polls or callback servers may hold the event loop after an abort.
setTimeout(() => process.exit(), 200).unref();
