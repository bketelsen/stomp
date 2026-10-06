// Reading pi-durable views and the state snapshot: message content, tool summaries, reports, usage, and times.
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, InboxState, LiveState, ToolSlot, UsageState } from "@earendil-works/pi-durable";
import { useSyncExternalStore } from "react";
import {
	type ConversationView,
	REPORT_PREFIX,
	REVIEW_ENTRY,
	type ReviewRecord,
	type StateSnapshot,
	type ThreadInfo,
} from "../shared/protocol.ts";

export type { AssistantMessage, EntryRecord, LiveState, ToolResultMessage, ToolSlot };

export const live = (view: ConversationView | undefined) => view?.docs["pi.live"] as LiveState | undefined;
export const inbox = (view: ConversationView | undefined) => (view?.docs["pi.inbox"] as InboxState | undefined)?.items ?? [];
export const message = (entry: EntryRecord): Message | undefined => entry.model?.[0];

type Content = string | readonly { type: string; text?: string }[] | undefined;
export const textOf = (content: Content) =>
	typeof content === "string" ? content : (content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

export const href = (thread: number) => `#/thread/${thread}`;
export const notebookHref = (agent: string) => `#/agent/${encodeURIComponent(agent)}/notebook`;
export const titleOf = (thread: ThreadInfo) => (thread.desk ? "desk" : thread.title || `thread ${thread.id}`);
/** The agent owning a delegated thread's `delegatedBy` thread: the supervisor. */
export const delegator = (snapshot: StateSnapshot | undefined, thread: ThreadInfo) =>
	snapshot?.agents.find((a) => a.id === snapshot.threads.find((t) => t.id === thread.delegatedBy)?.agent);

/** A report the supervisor received from a delegated thread: who sent it, from where, what it says, and its review line. */
export function reportOf(text: string) {
	const match = REPORT_PREFIX.exec(text);
	if (!match) return undefined;
	const body = text.slice(match[0].length).trimEnd();
	const cut = body.lastIndexOf("\n");
	const last = body.slice(cut + 1);
	const review = last.startsWith("Review:") ? { body: body.slice(0, Math.max(cut, 0)), review: last } : { body };
	return { name: match[1]!, thread: Number(match[2]), ...review };
}

/** A duty's wake, as its thread's first input: `[duty <name>]` and then what the check said. */
const DUTY_PREFIX = /^\[duty ([^\]]+)\]\s*/;
export function dutyOf(text: string) {
	const match = DUTY_PREFIX.exec(text);
	return match ? { name: match[1]!, body: text.slice(match[0].length) } : undefined;
}

/** A repo as shown: "owner/name", or a local repo's directory name. */
export const repoLabel = (repo: string) => (repo.startsWith("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo);

/** "provider · modelId" from "provider/modelId". */
export const modelLabel = (ref: string) => ref.replace("/", " · ");

/** A review card's record: the data of a `stomp.review` entry. */
export const reviewOf = (entry: EntryRecord) => (entry.kind === REVIEW_ENTRY ? (entry.data as unknown as ReviewRecord) : undefined);

/** A reviewer's blocking findings, sent into the author's thread as input: `[review by <model> (<family>)]`. */
const FIX_PREFIX = /^\[review (?:by|from) ([^\]]+?)(?:, round (\d+))?\]\s*/;
export function fixOf(text: string) {
	const match = FIX_PREFIX.exec(text);
	return match ? { reviewer: match[1], round: match[2], body: text.slice(match[0].length) } : undefined;
}

/** The last `lines` lines of `text`, and how many came before them. */
export function tail(text: string, lines = 40): { text: string; dropped: number } {
	const all = text.replace(/\n+$/, "").split("\n");
	return { text: all.slice(-lines).join("\n"), dropped: Math.max(0, all.length - lines) };
}

const clip = (text: string, n = 120) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** One line describing a tool call's arguments: the bash command, the file path, or the first string. */
export function toolSummary(name: string, args: Record<string, unknown> | undefined): string {
	if (args === undefined) return "";
	const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
	if (name === "bash" || name === "powershell") return clip(str("command").split("\n")[0] ?? "");
	if (str("path")) return clip(str("path") + (typeof args.offset === "number" ? `:${args.offset}` : ""));
	const first = Object.values(args).find((value) => typeof value === "string") as string | undefined;
	return clip((first ?? JSON.stringify(args)).split("\n")[0] ?? "");
}

const SUMMARIZED = new Set(["path", "offset", "limit", "command", "timeout"]);

/** The full arguments for an opened card, when the summary line doesn't already say everything. */
export function toolDetail(name: string, args: Record<string, unknown> | undefined): string | undefined {
	const command = name === "bash" && typeof args?.command === "string" ? args.command : undefined;
	if (command !== undefined) return command.includes("\n") || command.length > 80 ? command : undefined;
	if (args && Object.keys(args).some((key) => !SUMMARIZED.has(key))) return JSON.stringify(args, null, 2).slice(0, 4000);
	return undefined;
}

/** Thread tokens from `pi.usage`: what went in (cache included) and what came out. */
export function usageOf(view: ConversationView | undefined): { input: number; output: number } | undefined {
	const usage = view?.docs["pi.usage"] as UsageState | undefined;
	const buckets = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
	const total = buckets.reduce(
		(sum, u) => ({ input: sum.input + u.input + u.cacheRead + u.cacheWrite, output: sum.output + u.output }),
		{ input: 0, output: 0 },
	);
	return total.input + total.output > 0 ? total : undefined;
}

export const tokens = (n: number) =>
	n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;

// One shared clock for relative times, ticking every 30 s.
let now = Date.now();
const clock = new Set<() => void>();
setInterval(() => {
	now = Date.now();
	for (const listener of clock) listener();
}, 30_000);
const onTick = (listener: () => void) => {
	clock.add(listener);
	return () => clock.delete(listener);
};
export const useNow = () => useSyncExternalStore(onTick, () => now);

export function ago(ts: number, at: number): string {
	const s = Math.max(0, (at - ts) / 1000);
	if (s < 45) return "now";
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A time ahead: "in 5m", "in 3h", "in 2d", or "now" once it's due. */
export const ahead = (ts: number, at: number, s = (ts - at) / 1000) =>
	s < 45 ? "now" : `in ${s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`}`;
