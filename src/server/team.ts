// The supervisor's team section: a roster from the agent files and how delegation works. It changes only when agent
// files change, never with live status, so the prompt cache stays warm.
import { section } from "@earendil-works/pi-durable";
import type { AgentConfig } from "./agents.ts";

/** The first lines of the agent's "## Responsibilities" section. */
function responsibilities(instructions: string): string[] {
	const match = /^##[ \t]+Responsibilities[ \t]*\n([\s\S]*?)(?=^#{1,2}[ \t]|(?![\s\S]))/m.exec(instructions);
	return (match?.[1] ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 4);
}

const GUIDANCE = `How to work with them:
- Delegate work to the agent it belongs to. Every change goes to an agent.
- For a code change, give \`delegate\` the repo: the agent works on a branch of its own, and the report waits for a review.
- \`delegate\` returns at once. The report arrives later as a message starting with "[report from …]".
- Keep talking with Brian meanwhile. Don't wait for reports or poll threads.
- If a report asks a question Brian already answered, reply with \`message\`; otherwise ask Brian.
- Sum up each report for Brian briefly.
- \`read\` lists threads or shows one; \`cancel\` stops one.
- Threads titled "duty: …" come from an agent's scheduled checks; relay what matters in their reports.
- Save what's worth knowing next time with \`remember\`.`;

export const teamSection = (agents: () => readonly AgentConfig[]) =>
	section("team", () => {
		const team = agents().filter((agent) => agent.role === "agent" && agent.error === undefined);
		const roster = team.flatMap((agent) => [
			`- ${agent.name} (id: ${agent.id}, ${agent.family})`,
			...responsibilities(agent.instructions).map((line) => `  ${line}`),
		]);
		return `Your team:\n${roster.join("\n") || "(nobody yet)"}\n\n${GUIDANCE}`;
	});
