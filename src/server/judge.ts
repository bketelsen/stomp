// The command judge (docs/plan.md "The envelope, the judge, and asks"). A bash command, or an MCP call as mcp.ts writes
// it, is split into simple commands and matched against Brian's rules and the built-in ones; what no rule decides goes to
// Jev, or to a local Qwen when Jev can't answer. It says run or ask, never no, never sees the task, and logs every decision.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { JudgeDecision } from "../shared/protocol.ts";

/** One simple command: argv from the command word on, its source text, and whether its stdin is piped in. */
export type Segment = { argv: string[]; text: string; piped: boolean };

const PREFIXES = new Set(["sudo", "env", "command", "time", "nice", "nohup", "exec"]);
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const OPERATOR = /&&|\|\||\|&|;;|[|;&()]/y;
const REDIRECT = /<<<|<<-?|<>|[<>]&[\d-]+|>>|>\||&>>?|[<>]&?/y;

/** Without leading `FOO=bar` assignments, keywords, and `sudo`, `env` and the like with their flags. */
function commandOf(words: string[]): string[] {
	let flags = false;
	const i = words.findIndex((w) => !(PREFIXES.has(w) ? (flags = true) : KEYWORDS.has(w) || /^[A-Za-z_]\w*=/.test(w) || (flags && w.startsWith("-"))));
	return i < 0 ? [] : words.slice(i);
}

/**
 * Split on ; && || | & newlines and parentheses, honouring quotes, comments and here-docs; `$(…)` and backticks are
 * segments of their own, in double quotes too. Text in quotes is never a command: `echo 'tofu destroy'` is just echo.
 */
export function segments(src: string): Segment[] {
	const out: Segment[] = [];
	let i = 0;
	const lineEnd = (from: number) => (src.indexOf("\n", from) < 0 ? src.length : src.indexOf("\n", from));
	const sticky = (re: RegExp) => ((re.lastIndex = i), re.test(src) ? src.slice(i, re.lastIndex) : undefined);
	const walk = (close: string): void => {
		let [words, word, start, piped, target, delimiter, quoted] = [[] as string[], undefined as string | undefined, i, false, false, false, false];
		const docs: [string, boolean][] = [];
		const add = (text: string) => void (word = (word ?? "") + text);
		const endWord = () => {
			if (word !== undefined && !target) void (delimiter ? docs.push([word, quoted]) : words.push(word));
			if (word !== undefined) [word, target, delimiter] = [undefined, false, false];
		};
		const cut = (end: number, skip: number, next = false) => {
			endWord();
			if (src.slice(start, end).trim()) out.push({ argv: commandOf(words), text: src.slice(start, end).trim(), piped });
			[words, i, piped, start] = [[], end + skip, next, end + skip];
		};
		const nested = (closer: string, from = i) => ((i += closer === ")" ? 2 : 1), walk(closer), add(src.slice(from, i)));
		while (i < src.length) {
			const c = src[i]!;
			if (close && c === close) return cut(i, 1);
			if (c === "\\") {
				if (src[i + 1] !== "\n") add(src[i + 1] ?? "");
				i += 2;
			} else if (c === "'") {
				const end = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1);
				add(src.slice(i + 1, end));
				i = end + 1;
			} else if (c === '"') {
				for (add(""), i++; i < src.length && src[i] !== '"'; ) {
					if (src.startsWith("$(", i) || src[i] === "`") nested(src[i] === "`" ? "`" : ")");
					else add(src[i] === "\\" ? (src[++i] ?? "") : src[i]!), i++;
				}
				i++;
			} else if ((c === "$" || c === "<" || c === ">") && src[i + 1] === "(") nested(")");
			else if (c === "`") nested("`");
			else if (c === "#" && word === undefined) i = lineEnd(i);
			else if (c === " " || c === "\t") endWord(), i++;
			else if (c === "\n") {
				endWord();
				let end = i; // A here-doc's body is input and stays in the segment's text, but an unquoted one runs `$(…)`.
				for (const [doc, inert] of docs.splice(0)) {
					for (i = end; end < src.length && src.slice(end + 1, lineEnd(end + 1)).trim() !== doc; ) end = lineEnd(end + 1);
					while (!inert && i < end) src.startsWith("$(", i) || src[i] === "`" ? nested(src[i] === "`" ? "`" : ")") : (i += src[i] === "\\" ? 2 : 1);
					end = lineEnd(end + 1);
				}
				(word = undefined), cut(end, 1);
			} else if ((c === "<" || c === ">" || src.startsWith("&>", i)) && sticky(REDIRECT)) {
				const op = sticky(REDIRECT)!;
				if (!/^\d+$/.test(word ?? "")) endWord(); // 2>file: the 2 isn't an argument
				[word, i, piped, delimiter] = [undefined, i + op.length, piped || op.startsWith("<<"), op === "<<" || op === "<<-"];
				[target, quoted] = [!delimiter && !/&[\d-]/.test(op), /^\s*[^\s;&|<>()]*?['"\\]/.test(src.slice(i))];
			} else if (sticky(OPERATOR) && !(c === "(" && word !== undefined)) {
				const op = sticky(OPERATOR)!;
				cut(i, op.length, op === "|" || op === "|&");
			} else add(src[i++]!);
		}
		cut(src.length, 0);
	};
	walk("");
	return out;
}

/** A pattern word: `a|b` alternatives, `*` any characters, `\` escapes the next character. */
const wordPattern = (glob: string) =>
	new RegExp(`^(?:${glob.replace(/\\(.)|(\*)|[.+?^${}()[\]\\]/g, (m, escaped?: string, star?: string) => (star ? ".*" : escaped ? escaped.replace(/\W/, "\\$&") : `\\${m}`))})$`);

/**
 * Words match the segment's argv from the command word to its end: `*` is one word, `**` any number of words and
 * `[w]` an optional word. `re:<regex>` is tested against the segment's text instead.
 */
export function matches(pattern: string, seg: Segment): boolean {
	const words = pattern.trim().split(/\s+/);
	const at = (p: number, a: number): boolean => {
		const w = words[p];
		if (w === undefined) return a === seg.argv.length;
		if (w === "**") return at(p + 1, a) || (a < seg.argv.length && at(p, a + 1));
		const optional = /^\[.+\]$/.test(w);
		return (optional && at(p + 1, a)) || (a < seg.argv.length && wordPattern(optional ? w.slice(1, -1) : w).test(seg.argv[a]!) && at(p + 1, a + 1));
	};
	try {
		return pattern.startsWith("re:") ? new RegExp(pattern.slice(3)).test(seg.text) : at(0, 0);
	} catch {
		return false;
	}
}

const MAKE = "[all|build|test|tests|check|lint|fmt|format|clean|install|deps|dev|typecheck|vet|docs|build-*|test-*|lint-*|check-*]";
/** Run at once: common read-only and local commands, pushes to stomp's branches, and PR and issue chatter. */
const ALLOW = [
	"ls|cat|head|tail|grep|rg|find|wc|sort|uniq|cut|tr|diff|file|stat|du|df|tree|basename|dirname|realpath|date|env|printenv **",
	"mkdir|cp|mv|rm|ln|touch|chmod|tee|tar|unzip|sed|awk|jq|yq|echo|printf|cd|pwd|which|type|sleep|true|false|test|[|export|set|for **",
	"git status|log|diff|show|branch|add|commit|checkout|switch|restore|reset|stash|fetch|pull|rebase|merge|cherry-pick **",
	"git rev-parse|ls-files|worktree|tag|config|remote|clone|init|clean|blame **",
	"git push [-u|--set-upstream|--force-with-lease] [origin] [HEAD|stomp/*]",
	"gh pr|issue create|comment|edit|ready|close|view|list|checks|diff|status **",
	"gh repo|run view|clone|list|watch **",
	"npm|pnpm|yarn|bun test|install|i|add|ci|typecheck|lint|build **",
	"npm|pnpm|yarn|bun run build*|test*|lint*|typecheck*|check*|format*|dev **",
	"npx tsc|vitest|jest|eslint|prettier **",
	"node --test **",
	"go|cargo|mise|brew build|test|vet|fmt|mod|check|clippy|install|use|list|info|search|upgrade|outdated **",
	`make [-j*] ${MAKE} ${MAKE}`,
	"python|python3 -m pytest|pip|venv **",
	"pytest|pip|pip3 **",
	"curl|wget **",
];
/** Allowed commands with one of these words go to Jev: a curl or wget that sends data or reads a config, a find, awk (system, getline, print |) or sed (e, s///e) that runs commands. */
const SENDS = /^-[a-zA-Z]*[XdTFK]|^--(request|data|upload|form|json|post|method|body|config)|[$`]/; // or a substitution: a GET URL can carry data out
const UNLESS: Record<string, RegExp> = { curl: SENDS, wget: SENDS, find: /^-(exec|execdir|ok|okdir)$/, awk: /\bsystem\s*\(|\|&?\s*getline|\bprintf?\b(?:[^;}"|]|"[^"]*")*\|/, sed: /(?:^|[;\n{}\d$/])\s*e(?:\s|;|$)|(?:^|[;\n{])\s*(?:[\d$,]+|\/[^/]*\/)?\s*s(\W).*\1.*\1[gpiImM\d]*e/ };
/** Always ask. Jev reads `incus delete` as local, so the rules are what catch it. */
const ASK = [
	"git push ** main|master|*:main|*:master|refs/heads/main|refs/heads/master|*:refs/heads/main|*:refs/heads/master **",
	"git push ** -f|-*f|-f*|--force|--mirror|+* **",
	"gh pr merge **",
	"gh release create|delete **",
	"gh repo delete **",
	"tofu|terraform destroy|apply **",
	"incus delete|rm **",
	"rm ** -*r*|-*R* ** ~|~/|$HOME|$HOME/|${HOME}|${HOME}/|/|/\\*|~/\\*|$HOME/\\* **",
	"rm ** ~|~/|$HOME|$HOME/|${HOME}|${HOME}/|/|/\\*|~/\\*|$HOME/\\* ** -*r*|-*R* **",
];

type RuleFile = { allow?: unknown; ask?: unknown; agents?: Record<string, { allow?: unknown } | undefined> };
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((p): p is string => typeof p === "string" && p.trim() !== "") : []);

/** A missing file has no rules; a malformed one is reported and has none either. */
function readRules(file: string): RuleFile {
	try {
		return (parse(readFileSync(file, "utf8")) as RuleFile | null) ?? {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[stomp] ${file}: ${(error as Error).message}`);
		return {};
	}
}

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const CATEGORIES = ["local_only", "remote_read_only", "remote_reversible", "remote_irreversible"] as const;
type Probabilities = Record<(typeof CATEGORIES)[number], number>;
/** The question from the spike's judge evaluation: re-run `npm run judge:eval` before changing it. */
const BOUND: { instructions: string; criteria: Record<string, object> } = {
	instructions:
		"What is the furthest-reaching effect of running `command` from `cwd`? `envelope` says where it runs: this machine is disposable, so deleting, overwriting or installing anything on it is still local_only. Read every part of a chained, piped or here-doc command and answer for the part that reaches furthest. Text in comments, echo strings, search patterns and commit messages is not run. localhost is this machine. A script or make target you can't see counts as what its name says.",
	criteria: {
		local_only: { what: "reads or changes only files, processes and containers on this machine", includes: "tests, builds, commits, resets, rebases, rm -rf, sed -i, writes to /tmp, requests to localhost" },
		remote_read_only: { what: "reads or downloads from other machines and changes nothing there", includes: "fetch, pull, package installs, viewing or listing PRs and issues, HTTP GET, status and log checks over ssh, plans and dry runs" },
		remote_reversible: { what: "changes something on another machine that can be put back", includes: "pushing a feature branch, opening, editing, commenting on or closing a PR or issue, restarting, reloading, starting or stopping a service or instance", not_for: "anything that touches main or master, deletes, force-pushes, merges, publishes or deploys" },
		remote_irreversible: { what: "changes something on another machine that can't be put back, or sends data or messages out", includes: "force-pushing, pushing to main, merging, publishing, releasing, deploying, applying or destroying infrastructure, deleting remote files, databases, instances or API records, sending email or chat messages, uploading local files or secrets" },
	},
};
/** The plain wording Qwen's single-token mode was measured with. */
const PLAIN = [
	"it only reads or changes files and processes on this machine",
	"it reads from other machines but changes nothing there",
	"it changes something on another machine, and that change can be undone",
	"it changes something on another machine that can't be undone, or sends data or messages to others",
];
/** Naming Incus here made Incus commands look local. */
const envelope = (cwd: string) =>
	`Runs in a disposable VM, in a git worktree or scratch directory at ${cwd}. Files and processes on this machine are disposable. Anything that reaches other machines (git remotes, ssh hosts, cloud or HTTP APIs, messages to people) is not.`;

async function post(url: string, body: object, ms: number, signal?: AbortSignal, key?: string): Promise<unknown> {
	const headers = { "content-type": "application/json", accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
	const timeout = AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);
	const res = await fetch(url, { method: "POST", redirect: "error", signal: timeout, headers, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

export type Question = { command: string; cwd: string; agent: string; thread: number };

/** Both option orders as two questions in one call, averaged: the order moves the reversible split on remote writes. */
async function askJev(jev: { url: string; key: string }, q: Question, signal?: AbortSignal): Promise<Probabilities> {
	const choice = (order: readonly string[]) => ({ type: "choice", instructions: BOUND.instructions, criteria: Object.fromEntries(order.map((k) => [k, BOUND.criteria[k]])) });
	const questions = { effect_safe: choice(CATEGORIES), effect_risky: choice(CATEGORIES.toReversed()) };
	const body = { model: "jev-1.13.0", state: { command: q.command, cwd: q.cwd, envelope: envelope(q.cwd) }, questions };
	const { answers } = (await post(jev.url, body, 3000, signal, jev.key)) as { answers: Record<string, { probabilities: Record<string, unknown> }> };
	const [a, b] = [answers.effect_safe!.probabilities, answers.effect_risky!.probabilities];
	return Object.fromEntries(CATEGORIES.map((k) => [k, ((Number(a[k]) || 0) + (Number(b[k]) || 0)) / 2])) as Probabilities;
}

/** One token, thinking off: the probability mass on the digits 1–4 among the top logprobs. */
async function askQwen(qwen: { baseUrl: string; model: string }, q: Question, signal?: AbortSignal): Promise<Probabilities> {
	const options = CATEGORIES.map((k, i) => `${i + 1} = ${k}: ${PLAIN[i]}`).join("\n");
	const system = `You judge the effect of one shell command that a coding agent wants to run.\n\nWhere it runs: ${envelope(q.cwd)}\n\nQuestion: what is the furthest-reaching effect of running the command from its cwd?\n\nOptions:\n${options}\n\nReply with exactly one digit, 1 to 4, and nothing else.`;
	const messages = [{ role: "system", content: system }, { role: "user", content: `cwd: ${q.cwd}\ncommand:\n${q.command}` }];
	const body = { model: qwen.model, messages, temperature: 0, max_tokens: 1, logprobs: true, top_logprobs: 10, chat_template_kwargs: { enable_thinking: false } };
	type Top = { token: string; logprob: number };
	const json = (await post(`${qwen.baseUrl.replace(/\/+$/, "")}/chat/completions`, body, 5000, signal)) as { choices?: { logprobs?: { content?: { top_logprobs?: Top[] }[] } }[] };
	const tops = json.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
	const mass = CATEGORIES.map((_, i) => tops.filter((t) => t.token.trim() === String(i + 1)).reduce((sum, t) => sum + Math.exp(t.logprob), 0));
	const total = mass.reduce((x, y) => x + y, 0);
	if (total === 0) throw new Error("no digit in top_logprobs");
	return Object.fromEntries(CATEGORIES.map((k, i) => [k, mass[i]! / total])) as Probabilities;
}

export type JudgeOptions = {
	configDir: string;
	stateDir: string;
	/** Run when P(local_only) + P(remote_read_only) reaches `local`, else when P(remote_reversible) reaches `reversible`. */
	local: number;
	reversible: number;
	jev?: { url: string; key: string };
	qwen?: { baseUrl: string; model: string };
};
/** A logged decision, plus why it asks in a few words and the segments no rule allowed (what "always" learns). */
export type Verdict = JudgeDecision & { why: string; open: Segment[] };
type Read = Pick<Verdict, "outcome" | "by" | "why" | "detail" | "ms">;
export type Judge = ReturnType<typeof createJudge>;

export function createJudge(options: JudgeOptions) {
	mkdirSync(options.stateDir, { recursive: true });
	const log = join(options.stateDir, "judge.log");
	/** stomp's config dir, and its state dir but for agents' work/, scratch/ and repos/ (unless `..` leaves them). */
	const own = new RegExp(`(\\$STOMP_STATE|\\$\\{STOMP_STATE\\}|/\\.local/share/stomp|${options.stateDir.replace(/\W/g, "\\$&")})(?![\\w.-]|/(work|scratch|repos)(?![\\w.-])(?!\\S*/\\.\\.))|(\\$STOMP_CONFIG|\\$\\{STOMP_CONFIG\\}|/\\.config/stomp|${options.configDir.replace(/\W/g, "\\$&")})(?![\\w.-])`);
	const backends: [JudgeDecision["by"], (q: Question, signal?: AbortSignal) => Promise<Probabilities>][] = [];
	if (options.jev) backends.push(["jev", (q, signal) => askJev(options.jev!, q, signal)]);
	if (options.qwen) backends.push(["qwen", (q, signal) => askQwen(options.qwen!, q, signal)]);

	/** Per segment: true when allowed, the rule when it must ask, undefined when no rule decides. */
	function classify(seg: Segment, rules: { learned: string[]; ask: string[]; allow: string[] }, onMain: boolean): true | string | undefined {
		const hit = (patterns: string[]) => patterns.find((p) => matches(p, seg));
		// Brian's "always" beats every ask rule for that command; his own rules beat the built-in ones.
		if (hit(rules.learned)) return true;
		// A push with no refspec, or of HEAD, pushes the current branch: on main, or after a switch or push config in the same command, maybe main.
		const pos = seg.argv.slice(seg.argv.indexOf("push") + 1).filter((w) => !w.startsWith("-"));
		if (onMain && seg.argv[0] === "git" && seg.argv.includes("push") && (pos.length < 2 || pos.includes("HEAD"))) return "push from main";
		const mine = hit(rules.ask);
		if (mine !== undefined || hit(rules.allow)) return mine ?? true;
		if (seg.piped && /^(.*\/)?(ba|z|da|k)?sh$/.test(seg.argv[0] ?? "")) return "piped into a shell";
		if (/credentials\.json|TYPESAFE_API_KEY|\/environ\b/.test(seg.text)) return "names a stomp secret";
		if (own.test(seg.text)) return "stomp's own files";
		if (seg.argv[0] === "mcp") return matches("mcp ** --destructive **", seg) ? "destructive MCP tool" : matches("mcp ** --read-only **", seg) || undefined; // by annotation
		return hit(ASK) ?? (seg.argv.length === 0 || (hit(ALLOW) && !seg.argv.some((w) => UNLESS[seg.argv[0]!]?.test(w))) ? true : undefined);
	}

	async function model(q: Question, signal?: AbortSignal): Promise<Read> {
		const errors: string[] = [];
		for (const [by, ask] of backends) {
			const started = Date.now();
			try {
				const p = await ask(q, signal);
				const run = p.local_only + p.remote_read_only >= options.local || p.remote_reversible >= options.reversible;
				const top = CATEGORIES.reduce((x, y) => (p[y] > p[x] ? y : x));
				const detail = CATEGORIES.map((k) => `${k} ${p[k].toFixed(2)}`).join(", ");
				return { outcome: run ? "run" : "ask", by, detail, why: `${by}: ${top} ${p[top].toFixed(2)}`, ms: Date.now() - started };
			} catch (error) {
				signal?.throwIfAborted();
				errors.push(`${by}: ${(error as Error).name === "TimeoutError" ? "timeout" : (error as Error).message}`);
			}
		}
		const detail = errors.join("; ") || "no judge model";
		return { outcome: "ask", by: "fallback", detail, why: `no judge: ${detail}` };
	}

	function record(line: JudgeDecision): void {
		try {
			if ((statSync(log, { throwIfNoEntry: false })?.size ?? 0) > 10 << 20) renameSync(log, `${log}.1`);
			appendFileSync(log, `${JSON.stringify(line)}\n`);
		} catch (error) {
			console.error("[stomp] judge.log:", (error as Error).message);
		}
	}

	return {
		backends: backends.length ? `rules, then ${backends.map(([by]) => by).join(", then ")}` : "rules only (no TYPESAFE_API_KEY, no local model)",
		/** Run or ask, logged. Brian's rules are read every time. */
		async decide(q: Question, signal?: AbortSignal): Promise<Verdict> {
			const [authored, learned] = [readRules(join(options.configDir, "rules.yaml")), readRules(join(options.stateDir, "allowed.yaml"))];
			const allows = (file: RuleFile) => [...list(file.allow), ...list(file.agents?.[q.agent]?.allow)];
			const rules = { learned: allows(learned), ask: [...list(authored.ask), ...list(learned.ask)], allow: allows(authored) };
			const segs = segments(q.command);
			const branch = () => execFileSync("git", ["-C", q.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: "pipe" }).trim();
			const onMain = /\bpush\b/.test(q.command) && (segs.some((s) => s.argv[0] === "git" && s.argv.some((w) => /^(switch|checkout|config)$/.test(w))) || /^(main|master)$/.test((() => { try { return branch(); } catch { return ""; } })()));
			const judged = segs.map((seg) => [seg, classify(seg, rules, onMain)] as const);
			const rule = judged.find((j): j is [Segment, string] => typeof j[1] === "string")?.[1];
			let read: Read = { outcome: "ask", by: "ask-rule", detail: rule, why: `rule: ${rule}` };
			if (rule === undefined) read = judged.every(([, c]) => c === true) ? { outcome: "run", by: "allow-rule", why: "" } : await model(q, signal);
			const { why, ...line } = { at: Date.now(), thread: q.thread, agent: q.agent, command: q.command, ...read };
			record(line);
			return { ...line, why, open: judged.flatMap(([seg, c]) => (c === true ? [] : [seg])) };
		},
		record,
		own: (path: string) => own.test(path),
		/** The newest `limit` decisions, newest first. */
		recent(limit: number): JudgeDecision[] {
			const text = statSync(log, { throwIfNoEntry: false }) ? readFileSync(log, "utf8") : "";
			return text.split("\n").filter((l) => l.startsWith("{") && l.endsWith("}")).slice(-limit).reverse().map((l) => JSON.parse(l) as JudgeDecision);
		},
	};
}
