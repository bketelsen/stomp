// npm run budget: NORTHSTAR's line budgets (non-blank lines). Prints a table; exits 1 if any limit is exceeded.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { configDir } from "../src/server/config.ts";

const root = join(import.meta.dirname, "..");
const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "").length;
const count = (files: string[]) => files.reduce((sum, file) => sum + lines(readFileSync(file, "utf8")), 0);
const walk = (dir: string): string[] =>
	!existsSync(dir)
		? []
		: readdirSync(dir).flatMap((name) => {
				const path = join(dir, name);
				return statSync(path).isDirectory() ? walk(path) : [path];
			});
const code = (file: string) => /\.(ts|tsx|js|css|html)$/.test(file) && !/\.test\.tsx?$/.test(file);

const source = ["src/server", "src/shared", "src/web"].flatMap((dir) => walk(join(root, dir))).filter(code);
const sourceLines = count(source);
const rows: [string, number, number][] = [
	["app source (src/server, src/shared, src/web)", sourceLines, 8000],
	["tests (≤ 1.5× source)", count(walk(join(root, "test")).filter((f) => f.endsWith(".ts"))), Math.floor(sourceLines * 1.5)],
	["docs/*.md", count(walk(join(root, "docs")).filter((f) => f.endsWith(".md"))), 1500],
];
// The judge: segments, rules, Jev, Qwen, routing and the log (src/server/judge*.ts). Asks and the guard are apart.
const judge = source.filter((f) => /^src\/server\/judge[^/]*\.ts$/.test(relative(root, f)));
rows.push(["judge (src/server/judge*.ts)", count(judge), 300]);
// The review module: the server's review-only files (src/server/review*.ts). Worktrees serve review but aren't only review.
const review = source.filter((f) => /^src\/server\/review[^/]*\.ts$/.test(relative(root, f)));
rows.push(["review (src/server/review*.ts)", count(review), 500]);

for (const dir of [join(root, "examples", "home"), configDir()]) {
	if (!existsSync(dir)) continue;
	const where = dir.startsWith(root) ? relative(root, dir) : dir;
	if (existsSync(join(dir, "house.md"))) rows.push([`${where}/house.md`, count([join(dir, "house.md")]), 25]);
	for (const file of walk(join(dir, "agents")).filter((f) => f.endsWith(".md"))) {
		const body = readFileSync(file, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
		rows.push([`${where}/agents/${relative(join(dir, "agents"), file)} (soul)`, lines(body), 60]);
	}
}

const width = Math.max(...rows.map(([what]) => what.length));
let over = false;
for (const [what, n, limit] of rows) {
	over ||= n > limit;
	console.log(`${what.padEnd(width)}  ${String(n).padStart(5)} / ${String(limit).padEnd(5)} ${n > limit ? "OVER" : "ok"}`);
}
process.exit(over ? 1 : 0);
