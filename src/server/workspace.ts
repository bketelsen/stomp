// Worktrees: a thread binds to at most one, on a branch of its own, and its commits there get reviewed. A repo is
// "owner/name" on GitHub (a base clone under $STOMP_STATE/repos, cloned with gh once and fetched after) or an absolute
// path to a local git repo. Nothing cleans worktrees up yet.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { type Binding, bindThread, ThreadsDoc } from "./threads.ts";

const run = promisify(execFile);
export const git = async (cwd: string, ...args: string[]): Promise<string> =>
	(await run("git", args, { cwd, maxBuffer: 64 << 20 })).stdout.trimEnd();

/** A repo's base clone and the commit new worktrees start from: the default branch's tip. */
export type Source = { repo: string; dir: string; sha: string };

export type Workspaces = {
	source(repo: string): Promise<Source>;
	add(source: Source, agent: string, thread: number): Promise<Binding>;
};

export function workspaces(stateDir: string): Workspaces {
	return {
		async source(repo) {
			if (isAbsolute(repo)) return { repo, dir: repo, sha: await git(repo, "rev-parse", "HEAD") };
			if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repo must be "owner/name" or an absolute path, not "${repo}"`);
			const dir = join(stateDir, "repos", repo);
			if (existsSync(dir)) await git(dir, "fetch", "--quiet", "origin");
			else {
				mkdirSync(join(dir, ".."), { recursive: true });
				await run("gh", ["repo", "clone", repo, dir, "--", "--quiet"]);
			}
			return { repo, dir, sha: await git(dir, "rev-parse", "origin/HEAD") };
		},
		async add({ repo, dir, sha }, agent, thread) {
			const worktree = join(stateDir, "work", `${agent}-${thread}`);
			const branch = `stomp/${agent}/${thread}`;
			await git(dir, "worktree", "add", "--quiet", "-b", branch, worktree, sha);
			return { repo, worktree, branch, base: sha };
		},
	};
}

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });

export const workspaceTool = (ws: Workspaces) =>
	defineTool({
		name: "workspace",
		description:
			"Get a git worktree of your own for a repo: \"owner/name\" on GitHub, or an absolute path to a local repo. It starts on a new branch from the default branch's tip and becomes your working directory. Commit there when a unit of work is done: another model reviews your commits. Calling it again returns the same worktree.",
		parameters: Type.Object({ repo: Type.String({ description: '"owner/name" or an absolute path' }) }),
		execute: async ({ repo }, api, c) => {
			const thread = api.conversationId as ConversationId;
			let row = (await api.snapshot(ThreadsDoc, c))?.threads[thread];
			if (row === undefined) return reply("This conversation isn't a stomp thread.", true);
			if (row.worktree === undefined) {
				const binding = await ws.add(await ws.source(repo), row.agent, thread);
				await api.commit((tx) => bindThread(tx, thread, binding), c);
				row = { ...row, ...binding };
			}
			return reply(`Your worktree for ${row.repo}: ${row.worktree}, on branch ${row.branch}. Work and commit there.`);
		},
	});
