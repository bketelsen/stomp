// A temp config and state directory, and helpers to wait for things.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Fixture = {
	root: string;
	configDir: string;
	stateDir: string;
	agent(id: string, text: string): void;
	/** fetch with stomp's API token, which it keeps in the state directory. */
	fetch(url: string, init?: RequestInit): Promise<Response>;
	cleanup(): void;
};

export function fixture(stompYaml = "families: { '^(w[0-9]|scripted)': test }\n"): Fixture {
	const root = mkdtempSync(join(tmpdir(), "stomp-test-"));
	const configDir = join(root, "config");
	const stateDir = join(root, "state");
	mkdirSync(join(configDir, "agents"), { recursive: true });
	writeFileSync(join(configDir, "stomp.yaml"), stompYaml);
	writeFileSync(join(configDir, "house.md"), "House rule: be kind.\n");
	return {
		root,
		configDir,
		stateDir,
		agent: (id, text) => writeFileSync(join(configDir, "agents", `${id}.md`), text),
		fetch: (url, init = {}) => fetch(url, { ...init, headers: { authorization: `Bearer ${readFileSync(join(stateDir, "token"), "utf8").trim()}` } }),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

export const agentFile = (name: string, model = "scripted/scripted-1", extra = "") =>
	`---\nmodel: ${model}\n${extra}---\n# ${name}\n\nYou are ${name}.\n`;

export async function until<T>(check: () => T | Promise<T>, timeoutMs = 10_000): Promise<Exclude<T, false | null | undefined>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value as Exclude<T, false | null | undefined>;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
