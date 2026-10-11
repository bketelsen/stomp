import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { workspaces } from "../src/server/workspace.ts";
import { fixture } from "./support/fixture.ts";

test("two preparations of the same repo at once both succeed, on first clone and on fetch", async (t) => {
	const f = fixture();
	t.after(f.cleanup);
	const origin = join(f.root, "origin");
	mkdirSync(origin);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const commit = (message: string) => {
		writeFileSync(join(origin, "log.txt"), `${message}\n`, { flag: "a" });
		git(origin, "add", "-A");
		git(origin, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message);
		return git(origin, "rev-parse", "HEAD");
	};
	git(origin, "init", "-q", "-b", "main");
	const first = commit("base");
	// A fake gh that clones the local origin slowly, so two clones overlap.
	const bin = join(f.root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), `#!/bin/sh\nsleep 0.3\nexec git clone --quiet "${origin}" "$4"\n`);
	chmodSync(join(bin, "gh"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	t.after(() => {
		process.env.PATH = path;
	});

	const ws = workspaces(f.stateDir);
	const cloned = await Promise.all([ws.source("owner/toy"), ws.source("owner/toy")]);
	assert.deepEqual(cloned.map((s) => s.sha), [first, first]);

	for (let i = 0; i < 5; i++) {
		const tip = commit(`next ${i}`);
		const fetched = await Promise.all([ws.source("owner/toy"), ws.source("owner/toy"), ws.source("owner/toy")]);
		assert.deepEqual(fetched.map((s) => s.sha), [tip, tip, tip]);
	}
	const added = await Promise.all([ws.add(cloned[0]!, "a", 1), ws.add(cloned[1]!, "b", 2)]);
	assert.deepEqual(added.map((b) => b.base), [first, first]);
});
