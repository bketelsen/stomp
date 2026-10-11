import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { StateSnapshot, WikiView } from "../src/shared/protocol.ts";
import { loadAgents } from "../src/server/agents.ts";
import { createJudge } from "../src/server/judge.ts";
import { startStomp } from "../src/server/stomp.ts";
import { locate, renderPage, stompWiki, wikiLink } from "../src/server/wiki.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { scriptedModels } from "./support/scripted.ts";

const github = (kind: string, path: string) => `https://github.com/o/w/${kind}/main/${path}`;
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

test("links between pages open in the viewer; other files, on GitHub; URLs stay", () => {
	const from = "docs/hosts/caddy.md";
	const cases: [string, string][] = [
		["../limitations.md", "#/wiki/docs/limitations.md"],
		["truenas.md#disks", "#/wiki/docs/hosts/truenas.md#disks"],
		["./selfie.md", "#/wiki/docs/hosts/selfie.md"],
		["/README.md", "#/wiki/README.md"],
		["../../README.md", "#/wiki/README.md"],
		["../", "#/wiki/docs/"],
		["../network", "#/wiki/docs/network"],
		["#ports", "#/wiki/docs/hosts/caddy.md#ports"],
		["my%20page.md", "#/wiki/docs/hosts/my%20page.md"],
		["../caf%C3%A9.md?plain=1#menu", "#/wiki/docs/caf%C3%A9.md#menu"],
		["Caddyfile.txt#L3", "https://github.com/o/w/blob/main/docs/hosts/Caddyfile.txt#L3"],
		["Caddyfile.txt", "https://github.com/o/w/blob/main/docs/hosts/Caddyfile.txt"],
		["https://example.com/x.md", "https://example.com/x.md"],
		["mailto:b@example.com", "mailto:b@example.com"],
		["my page.md", "#/wiki/docs/hosts/my%20page.md"],
	];
	for (const [href, want] of cases) assert.equal(wikiLink(from, href, github), want, href);
	assert.equal(wikiLink(from, "img/rack.png", github, true), "https://github.com/o/w/raw/main/docs/hosts/img/rack.png");
});

test("headings get GitHub's ids, so section links land", () => {
	const html = renderPage("a.md", "# Host: `caddy`\n\n## Ports & TLS\n\n## Ports & TLS\n\n[ports](#ports--tls-1)\n", github);
	assert.match(html, /<h1 id="host-caddy">Host: <code>caddy<\/code><\/h1>/);
	assert.match(html, /<h2 id="ports--tls">Ports &amp; TLS<\/h2>\n<h2 id="ports--tls-1">/);
	assert.match(html, /href="#\/wiki\/a.md#ports--tls-1"/);
});

test("a page renders as HTML with its links rewritten", () => {
	const html = renderPage("docs/index.md", "# Home\n\nSee [caddy](hosts/caddy.md) and [the web](https://example.com).\n\n![rack](rack.jpg)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", github);
	assert.match(html, /<h1 id="home">Home<\/h1>/);
	assert.match(html, /<a href="#\/wiki\/docs\/hosts\/caddy.md">caddy<\/a>/);
	assert.match(html, /<a href="https:\/\/example.com">the web<\/a>/);
	assert.match(html, /<img src="https:\/\/github.com\/o\/w\/raw\/main\/docs\/rack.jpg" alt="rack">/);
	assert.match(html, /<table>/);
});

test("viewer paths can't leave the checkout or reach hidden files", (t) => {
	const f = fixture();
	t.after(f.cleanup);
	const dir = join(f.root, "wiki");
	mkdirSync(join(dir, "docs", "hosts"), { recursive: true });
	mkdirSync(join(dir, ".git"));
	writeFileSync(join(dir, ".git", "config"), "secret\n");
	writeFileSync(join(f.root, "outside.md"), "# outside\n");
	for (const page of ["README.md", "docs/index.md", "docs/network.md", "docs/hosts/caddy.md"]) writeFileSync(join(dir, page), `# ${page}\n`);
	symlinkSync(join(f.root, "outside.md"), join(dir, "docs", "escape.md"));
	assert.equal(locate(dir, ""), "README.md");
	assert.equal(locate(dir, "docs/"), "docs/index.md");
	assert.equal(locate(dir, "docs/network"), "docs/network.md");
	assert.equal(locate(dir, "/docs/hosts/caddy.md"), "docs/hosts/caddy.md");
	assert.equal(locate(dir, "docs/hosts"), undefined);
	assert.equal(locate(dir, "docs/escape.md"), undefined);
	for (const path of ["../outside.md", "docs/../../outside.md", "..", ".git/config", "docs/.hidden.md", "docs\\..\\..\\outside.md"]) {
		assert.throws(() => locate(dir, path), { status: 400 }, path);
	}
});

/** A bare origin with the wiki's first commit, a clone to make GitHub-side edits in, and a fake gh that clones origin. */
function remote(root: string) {
	const origin = join(root, "origin.git");
	const upstream = join(root, "upstream");
	git(root, "init", "-q", "--bare", "-b", "main", origin);
	git(root, "clone", "-q", origin, upstream);
	mkdirSync(join(upstream, "docs", "hosts"), { recursive: true });
	writeFileSync(join(upstream, "README.md"), "# Homelab\n\n- [Network](docs/network.md)\n- [caddy](docs/hosts/caddy.md)\n");
	writeFileSync(join(upstream, "docs", "network.md"), "---\ntitle: Network\norder: 20\n---\n# The network\n\nBack to [home](../README.md).\n");
	writeFileSync(join(upstream, "docs", "index.md"), "---\ntitle: Home\norder: 10\n---\n# Home\n");
	writeFileSync(join(upstream, "docs", "hosts", "caddy.md"), "# caddy\n\nSee [the network](../network.md).\n");
	git(upstream, "add", "-A");
	git(upstream, "commit", "-qm", "first");
	git(upstream, "push", "-q", "origin", "main");
	const bin = join(root, "bin");
	mkdirSync(bin);
	// A fake gh: the checkout's origin reads as GitHub's URL, and git fetches and pushes it from the local bare repo.
	const url = "https://github.com/owner/homewiki.git";
	writeFileSync(join(bin, "gh"), `#!/bin/sh\nset -e\ngit clone --quiet "${origin}" "$4"\ngit -C "$4" remote set-url origin ${url}\ngit -C "$4" config url."${origin}".insteadOf ${url}\n`);
	chmodSync(join(bin, "gh"), 0o755);
	return { upstream, bin, origin, url };
}

test("the wiki is served from its live checkout behind the token, and the wiki agent is pointed at it", async (t) => {
	const f = fixture("families: { '^scripted': test }\nwiki: { repo: owner/homewiki }\n");
	const { bin } = remote(f.root);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	f.agent("keeper", agentFile("Keeper", "scripted/scripted-1", "wiki: true\n"));
	f.agent("other", agentFile("Other"));
	const stomp = await startStomp({ configDir: f.configDir, stateDir: f.stateDir, listen: "127.0.0.1:0", models: scriptedModels(() => ({ text: "ok" })) });
	t.after(async () => {
		process.env.PATH = path;
		await stomp.close();
		f.cleanup();
	});
	const dir = join(f.stateDir, "wiki", "owner", "homewiki");
	const view = async (page: string) => (await (await f.fetch(`${stomp.url}/api/wiki?path=${encodeURIComponent(page)}`)).json()) as WikiView;
	await until(async () => (await view("")).page);

	// The token guards it like the rest of the API; /wiki/<path> lands in the UI's route.
	assert.equal((await fetch(`${stomp.url}/api/wiki?path=README.md`)).status, 401);
	assert.equal((await fetch(`${stomp.url}/api/wiki?path=README.md&token=nope`)).status, 401);
	const redirect = await fetch(`${stomp.url}/wiki/docs/network.md`, { redirect: "manual" });
	assert.deepEqual([redirect.status, redirect.headers.get("location")], [302, "/#/wiki/docs/network.md"]);

	const front = await view("");
	assert.equal(front.repo, "owner/homewiki");
	assert.deepEqual(front.pages, [
		{ path: "README.md", title: "Homelab" },
		{ path: "docs/index.md", title: "Home" },
		{ path: "docs/network.md", title: "Network" },
		{ path: "docs/hosts/caddy.md", title: "caddy" },
	]);
	assert.equal(front.notice, undefined);
	assert.equal(front.page?.github, "https://github.com/owner/homewiki/blob/main/README.md");
	assert.match(front.page!.html, /<a href="#\/wiki\/docs\/hosts\/caddy.md">caddy<\/a>/);
	const network = (await view("docs/network")).page!;
	assert.equal(network.title, "Network");
	assert.doesNotMatch(network.html, /order: 20/);
	assert.match(network.html, /href="#\/wiki\/README.md"/);
	assert.equal((await view("docs/nothing.md")).page, undefined);
	for (const bad of ["../token", "docs/../../token", ".git/config"]) {
		const response = await f.fetch(`${stomp.url}/api/wiki?path=${encodeURIComponent(bad)}`);
		assert.equal(response.status, 400, bad);
		assert.doesNotMatch(await response.text(), /\[core\]|^[\w-]{40,}$/m);
	}
	const state = (await (await f.fetch(`${stomp.url}/api/state`)).json()) as StateSnapshot;
	assert.equal(state.wiki, "owner/homewiki");

	// The agent that opts in works in the checkout and is told how to publish; the others aren't.
	const keeper = await until(() => state.agents.find((a) => a.id === "keeper"));
	assert.equal(keeper.error, undefined);
	const agents = loadAgents(f.configDir, {
		resolveModel: () => ({ provider: "scripted", modelId: "scripted-1" }),
		families: [[/^scripted/, "test"]],
		scratch: join(f.stateDir, "scratch"),
		notes: join(f.stateDir, "notes"),
		duties: join(f.stateDir, "duties.yaml"),
		mcp: () => undefined,
		wiki: { repo: "owner/homewiki", dir, branch: "main" },
	});
	const [k, o] = [agents.find((a) => a.id === "keeper")!, agents.find((a) => a.id === "other")!];
	assert.equal(k.cwd, dir);
	assert.match(k.instructions, new RegExp(`## The wiki\\n${dir} is the live checkout of owner/homewiki on main.*\`git -C ${dir} push origin main\``, "s"));
	assert.doesNotMatch(o.instructions, /The wiki/);

	// An edit in the checkout is live on the next load, and the notice says what isn't on GitHub yet.
	writeFileSync(join(dir, "docs", "hosts", "caddy.md"), "# caddy\n\nNow on port 8443.\n");
	assert.match((await view("docs/hosts/caddy.md")).page!.html, /8443/);
	assert.equal((await view("")).notice, "1 file changed and not committed");
	git(dir, "commit", "-qam", "caddy port");
	assert.equal((await view("")).notice, "1 commit here not on GitHub yet");
});

test("syncing pulls GitHub's changes into a clean checkout, and leaves local edits and unpushed commits alone", async (t) => {
	const f = fixture();
	t.after(f.cleanup);
	const { upstream, bin, origin, url } = remote(f.root);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	t.after(() => {
		process.env.PATH = path;
	});
	const dir = join(f.stateDir, "wiki", "owner", "homewiki");
	let clones = 0;
	const wiki = stompWiki("owner/homewiki", dir, () => clones++);
	await wiki.sync();
	assert.deepEqual([clones, wiki.branch(), existsSync(join(dir, "docs", "index.md"))], [1, "main", true]);
	const upstreamEdit = (text: string) => {
		writeFileSync(join(upstream, "docs", "index.md"), text);
		git(upstream, "commit", "-qam", text);
		git(upstream, "push", "-q", "origin", "main");
	};

	upstreamEdit("# Home, edited on GitHub\n");
	await wiki.sync();
	assert.equal(readFileSync(join(dir, "docs", "index.md"), "utf8"), "# Home, edited on GitHub\n");

	// An uncommitted edit: nothing moves.
	upstreamEdit("# Home, again\n");
	writeFileSync(join(dir, "docs", "network.md"), "# Network, mid-edit\n");
	await wiki.sync();
	assert.equal(readFileSync(join(dir, "docs", "index.md"), "utf8"), "# Home, edited on GitHub\n");
	assert.equal((await wiki.view("")).notice, "1 file changed and not committed; 1 commit on GitHub not pulled yet");

	// A commit whose push failed (GitHub moved on): kept, and said so, until the agent rebases and pushes.
	git(dir, "commit", "-qam", "network");
	await wiki.sync();
	assert.equal(git(dir, "log", "-1", "--format=%s"), "network");
	assert.equal((await wiki.view("")).notice, "1 commit here not on GitHub yet; 1 commit on GitHub not pulled yet");
	assert.throws(() => git(dir, "push", "-q", "origin", "main"));
	git(dir, "pull", "-q", "--rebase", "origin", "main");
	git(dir, "push", "-q", "origin", "main");
	assert.equal((await wiki.view("")).notice, undefined);

	// A failed update is reported.
	git(dir, "config", "--remove-section", `url.${origin}`);
	git(dir, "config", `url.${join(f.root, "gone.git")}.insteadOf`, url);
	await wiki.sync();
	assert.match((await wiki.view("")).notice ?? "", /^updating from GitHub failed: .*gone\.git/);

	// A checkout whose origin isn't the configured repo is said so and left alone, edits and all.
	git(dir, "remote", "set-url", "origin", "git@github.com:someone/else.git");
	writeFileSync(join(dir, "docs", "network.md"), "# Network, mid-edit again\n");
	await wiki.sync();
	assert.match((await wiki.view("")).notice ?? "", /^this checkout's origin is git@github.com:someone\/else.git, not owner\/homewiki on GitHub/);
	assert.equal(readFileSync(join(dir, "docs", "network.md"), "utf8"), "# Network, mid-edit again\n");
	git(dir, "remote", "set-url", "origin", "git@github.com:owner/homewiki.git");
	assert.doesNotMatch((await wiki.view("")).notice ?? "", /origin is/);
});

test("with the one rule the wiki agent's file names, her edit-commit-push of the wiki never asks; other pushes to main still do", async (t) => {
	const f = fixture();
	t.after(f.cleanup);
	const dir = join(f.stateDir, "wiki", "owner", "homewiki");
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "commit", "-q", "--allow-empty", "-m", "first");
	writeFileSync(join(f.configDir, "rules.yaml"), `agents:\n  keeper:\n    allow:\n      - git -C ${dir} push origin main\n`);
	const judge = createJudge({ configDir: f.configDir, stateDir: f.stateDir, local: 0.7, reversible: 0.85 });
	const decide = async (agent: string, command: string, cwd = dir) => {
		const v = await judge.decide({ thread: 1, agent, command, cwd });
		return `${v.outcome} ${v.by}`;
	};
	const publish = `cd ${dir} && git add -A && git commit -qm "caddy: port 8443" && git -C ${dir} push origin main`;
	assert.equal(await decide("keeper", publish), "run allow-rule");
	assert.equal(await decide("keeper", `cd ${dir} && git pull --rebase origin main`), "run allow-rule");
	assert.equal(await decide("keeper", `cat > ${dir}/docs/x.md <<'EOF'\n# x\nEOF`), "run allow-rule");
	// Nothing broader: other agents, other repos and other pushes go to the judge's usual path, which asks here.
	const asks = [
		await decide("other", publish),
		await decide("keeper", "git push origin main", join(f.stateDir, "work", "keeper-1")),
		await decide("keeper", `git -C ${f.stateDir}/work/keeper-1 push origin main`),
		await decide("keeper", `git -C ${dir} push --force origin main`),
		await decide("keeper", `git -C ${dir} push origin main:other`),
		await decide("keeper", `git -C ${f.stateDir}/wiki/someone/else push origin main`),
	];
	assert.deepEqual(asks.map((a) => a.split(" ")[0]), Array(6).fill("ask"));
});
