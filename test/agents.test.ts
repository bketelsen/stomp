import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { type AgentContext, loadAgents, parseAgent } from "../src/server/agents.ts";
import { agentFile, fixture } from "./support/fixture.ts";

const fx = fixture();
after(fx.cleanup);
const context: AgentContext = {
	resolveModel: (spec) => {
		if (spec === "claude") return { provider: "anthropic", modelId: "claude-sonnet-5-5" };
		return spec.includes("/") ? { provider: "x", modelId: spec.split("/")[1]! } : `unknown model alias "${spec}"`;
	},
	families: [],
	scratch: join(fx.root, "scratch"),
	notes: join(fx.root, "notes"),
	duties: join(fx.root, "state", "duties.yaml"),
	mcp: (name) => (name === "nas" ? undefined : `unknown MCP server "${name}"`),
};

test("an agent file: frontmatter, name from the H1, house rules first, defaults", () => {
	const text = "---\nmodel: claude\nrepos: [a/b]\n---\nintro\n# Miles Teg\n\nBashar.\n";
	const agent = parseAgent("teg", text, "House.", context);
	assert.equal(agent.error, undefined);
	assert.deepEqual(
		{ name: agent.name, provider: agent.provider, modelId: agent.modelId, family: agent.family, role: agent.role, thinking: agent.thinking },
		{ name: "Miles Teg", provider: "anthropic", modelId: "claude-sonnet-5-5", family: "anthropic", role: "agent", thinking: "medium" },
	);
	assert.equal(agent.instructions, "House.\n\nintro\n# Miles Teg\n\nBashar.");
	assert.equal(agent.cwd, join(fx.root, "scratch", "teg"));
	assert.deepEqual([agent.duties, agent.mcp, parseAgent("t", agentFile("T", "claude", "mcp: [nas]\n"), "", context).mcp], [[], [], ["nas"]]);
	const duty = "duties:\n  - { name: hosts, every: 15m, check: 'nc -z h 22', brief: Say why. }\n  - { name: ci, every: 1d, check: x, wake: failed, brief: y }\n";
	const teg = parseAgent("teg", agentFile("T", "claude", duty), "", context, [{ name: "nightly", every: "1d", brief: "Look." }]);
	assert.deepEqual(teg.duties, [
		{ name: "hosts", every: "15m", ms: 900_000, check: "nc -z h 22", wake: "changed", brief: "Say why." },
		{ name: "ci", every: "1d", ms: 86_400_000, check: "x", wake: "failed", brief: "y" },
		{ name: "nightly", every: "1d", ms: 86_400_000, wake: "always", brief: "Look.", added: true },
	]);
	assert.match(teg.instructions, /\n\n## Your duties\n.*\n- hosts, every 15m: runs `nc -z h 22`, wakes when its result changes\. Brief: Say why\.\n- ci, .*\n- nightly, every 1d: wakes every time\. Brief: Look\.$/);
});

test("bad files get an error instead of throwing", () => {
	const error = (text: string) => parseAgent("x", text, "", context).error;
	assert.match(error("# No frontmatter\n")!, /frontmatter/);
	assert.match(error("---\nthinking: low\n---\n# X\n")!, /model is required/);
	assert.match(error(agentFile("X", "nope"))!, /unknown model alias "nope"/);
	assert.match(error(agentFile("X", "x/acme-code-1"))!, /unknown family/);
	assert.match(error(agentFile("X", "claude", "role: boss\n"))!, /role/);
	assert.match(error(agentFile("X", "claude", "thinking: lots\n"))!, /thinking/);
	assert.match(error(agentFile("X", "claude", "mcp: [nas, nope]\n"))!, /^unknown MCP server "nope"$/);
	assert.match(error(agentFile("X", "claude", "mcp: nas\n"))!, /mcp must be a list/);
	assert.match(error("---\nmodel: [unclosed\n---\n# X\n")!, /./);
	const duty = (yaml: string) => error(agentFile("X", "claude", `duties:\n  - { name: d, check: c, brief: b, ${yaml} }\n`));
	assert.match(duty("every: 4m")!, /^duty d: every must be .* at least 5m/);
	assert.match(duty("every: hourly")!, /every must be like 15m/);
	assert.match(duty("every: 1h, wake: sometimes")!, /wake must be one of changed, failed, always/);
	assert.match(error(agentFile("X", "claude", "duties:\n  - { name: d, every: 1h, brief: b, wake: failed }\n"))!, /^duty d: without a check, it can only wake every time/);
	assert.match(error(agentFile("X", "claude", "duties: hourly\n"))!, /duties must be a list/);
	assert.match(error(agentFile("X", "claude", "duties:\n  - { name: d, every: 1h, check: c, brief: b }\n  - { name: d, every: 2h, check: c, brief: b }\n"))!, /two duties/);
	const added = (list: unknown) => parseAgent("x", agentFile("X", "claude", "duties:\n  - { name: d, every: 1h, check: c, brief: b }\n"), "", context, list).error;
	assert.equal(added([{ name: "d", every: "2h", brief: "b" }]), "two duties are named d");
	assert.equal(added([{ name: "e", every: "1m", brief: "b" }]), "duties.yaml: duty e: every must be like 15m, 6h or 1d, and at least 5m");
	assert.equal(parseAgent("x", agentFile("X", "x/acme-code-1"), "", { ...context, families: [[/^acme/, "acme"]] }).family, "acme");
});

test("loading: only the first supervisor keeps the role, and duties.yaml adds duties unless it's malformed", (t) => {
	fx.agent("a", agentFile("A", "claude", "role: supervisor\n"));
	fx.agent("b", agentFile("B", "claude", "role: supervisor\n"));
	fx.agent("c", agentFile("C", "claude"));
	const agents = loadAgents(fx.configDir, context);
	assert.deepEqual(agents.map((a) => [a.id, a.error === undefined]), [["a", true], ["b", false], ["c", true]]);
	assert.match(agents[1]!.error!, /only one supervisor/);
	assert.match(agents[2]!.instructions, /^House rule: be kind\.\n\n# C/);
	// duties.yaml adds to an agent's duties; malformed, it's skipped.
	mkdirSync(join(fx.root, "state"), { recursive: true });
	writeFileSync(context.duties, "c:\n  - { name: n, every: 1h, brief: b }\n");
	assert.deepEqual(loadAgents(fx.configDir, context)[2]!.duties.map((d) => [d.name, d.added]), [["n", true]]);
	writeFileSync(context.duties, "c: [unclosed\n");
	t.mock.method(console, "error", () => {});
	assert.deepEqual(loadAgents(fx.configDir, context)[2]!.duties, []);
});
