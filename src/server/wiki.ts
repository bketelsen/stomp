// The wiki: a live checkout of a markdown repo (stomp.yaml's `wiki`) at $STOMP_STATE/wiki/<owner>/<name>, rendered per
// request with no build step. stomp clones it and fast-forwards it from GitHub while it's clean and fully pushed; the
// agent whose file says `wiki: true` edits, commits and pushes there. stomp never resets or discards: what isn't on GitHub yet shows as
// the page's notice.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { promisify } from "node:util";
import { Marked } from "marked";
import { parse } from "yaml";
import type { WikiEntry, WikiView } from "../shared/protocol.ts";
import { readOptional } from "./agents.ts";
import { HttpError } from "./http.ts";
import { git } from "./workspace.ts";

const run = promisify(execFile);
const PAGE = /\.(md|markdown)$/i;

/** A page's YAML frontmatter and the markdown after it. Frontmatter that doesn't parse stays in the body. */
function split(text: string): { meta: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	try {
		const meta: unknown = match && parse(match[1]!);
		if (match && meta !== null && typeof meta === "object") return { meta: meta as Record<string, unknown>, body: text.slice(match[0].length) };
	} catch {}
	return { meta: {}, body: text };
}

const titleOf = (path: string, meta: Record<string, unknown>, body: string): string =>
	(typeof meta.title === "string" && meta.title.trim()) || /^#[ \t]+(.+)$/m.exec(body)?.[1]!.trim() || posix.basename(path).replace(PAGE, "");

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
/** A file's URL on GitHub: its page, or its raw bytes. */
export type GitHub = (kind: "blob" | "raw", path: string) => string;

/**
 * Where a link on page `from` goes: a page (a `.md` file, or a path without an extension, like a folder) opens in the
 * viewer; any other file of the repo opens on GitHub, as an image its raw bytes; a URL with a scheme is left alone.
 * The path is percent-decoded as a URL's is; a `#section` stays on the link.
 */
export function wikiLink(from: string, href: string, github: GitHub, image = false): string {
	if (/^([a-z][\w+.-]*:|\/\/)/i.test(href)) return href;
	const [, written = "", fragment] = /^([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/s.exec(href)!;
	let target = written;
	try {
		target = decodeURIComponent(written);
	} catch {}
	const path = !target ? from : posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(from), target)).replace(/^\.\/?/, "");
	const section = fragment ? `#${fragment}` : "";
	if (!image && (PAGE.test(path) || !/\.[^/]*$/.test(path))) return `#/wiki/${encodePath(path)}${section}`;
	return github(image ? "raw" : "blob", path) + section;
}

/** A heading's id as GitHub makes it: lowercase, punctuation dropped, spaces to hyphens, repeats numbered. */
export const slugger = () => {
	const seen = new Map<string, number>();
	return (text: string) => {
		const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
		const n = seen.get(slug) ?? 0;
		seen.set(slug, n + 1);
		return n ? `${slug}-${n}` : slug;
	};
};

/** A page's markdown as HTML: links rewritten by wikiLink, headings with GitHub's ids. The browser sanitizes it. */
export function renderPage(path: string, body: string, github: GitHub): string {
	const slug = slugger();
	const marked = new Marked({
		gfm: true,
		renderer: {
			heading({ tokens, depth, text }) {
				return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
			},
		},
	});
	const tokens = marked.lexer(body);
	marked.walkTokens(tokens, (token) => {
		if (token.type === "link" || token.type === "image") token.href = wikiLink(path, token.href, github, token.type === "image");
	});
	return marked.parser(tokens);
}

/**
 * The page a viewer path names, relative to the checkout, or undefined. Hidden names (so `..` and `.git`) are refused
 * with a 400, and a file whose real path (through symlinks) leaves the checkout is no page.
 */
export function locate(dir: string, path: string): string | undefined {
	const parts = path.split("/").filter(Boolean);
	if (parts.some((part) => part.startsWith(".") || part.includes("\\") || part.includes("\0"))) throw new HttpError(400, `not a wiki path: ${path}`);
	const rel = parts.join("/");
	const candidates = PAGE.test(rel) ? [rel] : [...(rel ? [`${rel}.md`] : []), posix.join(rel, "README.md"), posix.join(rel, "index.md")];
	const root = realpathSync(dir);
	return candidates.find((candidate) => {
		try {
			const real = realpathSync(join(dir, candidate));
			return real.startsWith(root + sep) && statSync(real).isFile();
		} catch {
			return false;
		}
	});
}

/** Every page under `rel`, skipping hidden names, node_modules and symlinks. */
function walk(dir: string, rel = ""): string[] {
	return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		return entry.isDirectory() ? walk(dir, path) : entry.isFile() && PAGE.test(entry.name) ? [path] : [];
	});
}

function pages(dir: string): WikiEntry[] {
	const found = walk(dir).map((path) => {
		const { meta, body } = split(readFileSync(join(dir, path), "utf8"));
		return { path, title: titleOf(path, meta, body), order: typeof meta.order === "number" ? meta.order : Infinity };
	});
	const folder = (path: string) => (path.includes("/") ? posix.dirname(path) : "");
	found.sort((a, b) => folder(a.path).localeCompare(folder(b.path)) || a.order - b.order || a.title.localeCompare(b.title));
	return found.map(({ path, title }) => ({ path, title }));
}

const why = (error: unknown) => String((error as { stderr?: string }).stderr || (error as Error).message).trim();
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export type Wiki = {
	repo: string;
	dir: string;
	/** The checked-out branch, the repo's default; undefined until it's cloned. */
	branch(): string | undefined;
	/** Clone it if it's missing, else fetch and fast-forward if it's clean and fully pushed. Never throws. */
	sync(): Promise<void>;
	view(path: string): Promise<WikiView>;
	/** Sync now and every `everyMs`; returns stop, which waits for a sync under way. */
	start(everyMs: number): () => Promise<void>;
};

/** `cloned`: called after a clone, so the wiki agent's instructions can name the branch. */
export function stompWiki(repo: string, dir: string, cloned: () => void): Wiki {
	let failed: string | undefined;
	let syncing: Promise<void> | undefined;
	const branch = () => /^ref: refs\/heads\/(.+)$/m.exec(readOptional(join(dir, ".git", "HEAD")))?.[1];
	/** The checkout's origin as configured, when it isn't `repo` on GitHub: stomp then neither updates it nor vouches for it. */
	const foreign = async () => {
		const url = await git(dir, "config", "--get", "remote.origin.url").catch(() => "");
		return new RegExp(`github\\.com[:/]${repo.replace(/\./g, "\\.")}(\\.git)?/?$`, "i").test(url) ? undefined : url || "none";
	};
	const update = async () => {
		try {
			if (!existsSync(join(dir, ".git"))) {
				mkdirSync(dir, { recursive: true });
				await run("gh", ["repo", "clone", repo, dir, "--", "--quiet"]);
				cloned();
			} else if ((await foreign()) === undefined) {
				await git(dir, "fetch", "--quiet", "origin");
				// Only a checkout with nothing uncommitted and nothing unpushed moves, so the agent's work is never touched.
				const idle = !(await git(dir, "status", "--porcelain")) && (await git(dir, "rev-list", "--count", "@{u}..HEAD")) === "0";
				if (idle) await git(dir, "merge", "--ff-only", "--quiet", "@{u}");
			}
			failed = undefined;
		} catch (error) {
			failed = why(error);
			console.error(`[stomp] wiki ${repo}: ${failed}`);
		}
	};
	const sync = () => (syncing ??= update().finally(() => (syncing = undefined)));

	/** Derived from git each time: a foreign origin, commits not pushed, files not committed, and the last failed update. */
	async function notice(): Promise<string | undefined> {
		if (!existsSync(join(dir, ".git"))) return `The wiki isn't cloned yet${failed ? `: ${failed}` : "."}`;
		const other = await foreign();
		const [head = "", ...changed] = (await git(dir, "status", "--porcelain", "--branch")).split("\n").filter(Boolean);
		const [ahead, behind] = [/ahead (\d+)/, /behind (\d+)/].map((re) => Number(re.exec(head)?.[1] ?? 0));
		const parts = [
			other && `this checkout's origin is ${other}, not ${repo} on GitHub, so stomp doesn't update it; set it back with git remote set-url`,
			ahead && `${plural(ahead, "commit")} here not on GitHub yet`,
			changed.length && `${plural(changed.length, "file")} changed and not committed`,
			behind && `${plural(behind, "commit")} on GitHub not pulled yet`,
			failed && `updating from GitHub failed: ${failed}`,
		];
		return parts.filter(Boolean).join("; ") || undefined;
	}

	return {
		repo,
		dir,
		branch,
		sync,
		async view(path) {
			const notes = await notice();
			const base = { repo, ...(notes ? { notice: notes } : {}) };
			if (!existsSync(join(dir, ".git"))) return { ...base, pages: [] };
			const found = locate(dir, path);
			if (found === undefined) return { ...base, pages: pages(dir) };
			const github: GitHub = (kind, file) => `https://github.com/${repo}/${kind}/${encodePath(branch() ?? "HEAD")}/${encodePath(file)}`;
			const { meta, body } = split(readFileSync(join(dir, found), "utf8"));
			const page = { path: found, title: titleOf(found, meta, body), html: renderPage(found, body, github), github: github("blob", found) };
			return { ...base, pages: pages(dir), page };
		},
		start(everyMs) {
			void sync();
			const timer = setInterval(() => void sync(), everyMs);
			return async () => {
				clearInterval(timer);
				await syncing;
			};
		},
	};
}
