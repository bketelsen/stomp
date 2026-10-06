// One transcript entry, the live generation, tool cards, the supervisor's delegation cards and reports, review cards,
// notebook and consult cards, and duty wakes.
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { DelegateDetails, DelegationStatus } from "../shared/protocol.ts";
import { Markdown } from "./markdown.tsx";
import { ReviewCard, Verdict } from "./Review.tsx";
import { useStore } from "./store.ts";
import {
	type AssistantMessage,
	ago,
	dutyOf,
	type EntryRecord,
	fixOf,
	href,
	type LiveState,
	message,
	modelLabel,
	notebookHref,
	repoLabel,
	reportOf,
	reviewOf,
	type ToolResultMessage,
	type ToolSlot,
	tail,
	textOf,
	titleOf,
	toolDetail,
	toolSummary,
	useNow,
} from "./view.ts";

/** What the thread knows about tool calls: ids it shows, result entries, and live slots while the round runs. */
export type Calls = { called: Set<string>; results: Map<string, ToolResultMessage>; slots: Map<string, ToolSlot> };

export function Time({ ts }: { ts: number | undefined }) {
	const now = useNow();
	if (!ts) return null;
	return (
		<time className="shrink-0 text-xs text-muted" title={new Date(ts).toLocaleString()}>
			{ago(ts, now)}
		</time>
	);
}

function Divider({ label, children }: { label: string; children?: React.ReactNode }) {
	return (
		<details className="text-xs text-muted">
			<summary className="flex cursor-pointer list-none items-center gap-2 py-1 [&::-webkit-details-marker]:hidden">
				<span className="h-px flex-1 bg-line" />
				{label}
				<span className="h-px flex-1 bg-line" />
			</summary>
			{children && <div className="mt-2 rounded-lg border border-line p-3 text-sm text-fg">{children}</div>}
		</details>
	);
}

export const Entry = memo(function Entry({ entry, calls }: { entry: EntryRecord; calls: Calls }) {
	const m = message(entry);
	if (entry.kind === "pi.system" || entry.kind === "stomp.nudge") return null;
	if (entry.kind === "pi.compaction") return <Divider label="context compacted">{m && <Markdown text={textOf(m.content)} />}</Divider>;
	if (entry.kind === "pi.reset") return <Divider label="new context">{m && <Markdown text={textOf(m.content)} />}</Divider>;
	const review = reviewOf(entry);
	if (review) return <ReviewCard review={review} />;
	const report = m?.role === "user" ? reportOf(textOf(m.content)) : undefined;
	if (report) return <Report {...report} ts={m?.timestamp} />;
	const duty = m?.role === "user" ? dutyOf(textOf(m.content)) : undefined;
	if (duty) return <DutyWake {...duty} ts={m?.timestamp} />;
	const fix = m?.role === "user" ? fixOf(textOf(m.content)) : undefined;
	if (fix)
		return (
			<Delivered ts={m?.timestamp} body={fix.body}>
				<span className="min-w-0 flex-1 truncate">
					Review from <span className="font-medium text-fg">{fix.reviewer ? modelLabel(fix.reviewer) : "the reviewer"}</span>
					{fix.round && ` · round ${fix.round}`}
				</span>
			</Delivered>
		);
	if (m?.role === "user")
		return (
			<div className="flex flex-col items-end gap-0.5">
				<div className="max-w-[85%] rounded-2xl bg-user px-3.5 py-2 break-words whitespace-pre-wrap">{textOf(m.content)}</div>
				<Time ts={m.timestamp} />
			</div>
		);
	if (m?.role === "assistant") return <Assistant message={m} calls={calls} />;
	if (m?.role === "toolResult")
		// A result whose call is in unloaded history stands alone; others render inside their call's card.
		return calls.called.has(m.toolCallId) ? null : <ToolCard name={m.toolName} result={m} />;
	return <div className="text-xs text-muted">[{entry.kind}]</div>;
});

/** An assistant message, committed or streaming. */
export function Assistant({ message: m, calls, streaming }: { message: AssistantMessage; calls: Calls; streaming?: boolean }) {
	const interrupted = m.stopReason === "aborted";
	const failed = m.stopReason === "error";
	const said = m.content.some((block) => block.type === "text" && block.text.trim());
	return (
		<div className={`flex flex-col gap-2 ${interrupted ? "opacity-60" : ""}`}>
			{m.content.map((block, i) => {
				if (block.type === "thinking") return <Thinking key={i} text={block.thinking} streaming={streaming && i === m.content.length - 1} />;
				if (block.type === "text") return block.text ? <Markdown key={i} text={block.text} /> : null;
				const slot = calls.slots.get(block.id);
				const result = calls.results.get(block.id);
				const Card = result?.isError ? ToolCard : (CARDS[block.name] ?? ToolCard);
				return <Card key={i} name={block.name} args={block.arguments} slot={slot} result={result} preparing={streaming} />;
			})}
			{!streaming && (said || interrupted || failed) && (
				<div className="flex items-center gap-2 text-xs">
					{interrupted && <span className="text-warn">interrupted (not seen by the model)</span>}
					{failed && <span className="text-err">error: {m.errorMessage ?? "unknown"}</span>}
					<Time ts={m.timestamp} />
				</div>
			)}
		</div>
	);
}

function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
	if (!text.trim()) return null;
	if (streaming) return <div className="text-sm whitespace-pre-wrap text-muted italic">{tail(text, 3).text}</div>;
	return (
		<details className="text-sm text-muted">
			<summary className="cursor-pointer select-none">Thinking</summary>
			<div className="mt-1 border-l-2 border-line pl-3 whitespace-pre-wrap italic">{text}</div>
		</details>
	);
}

type CardProps = {
	name: string;
	args?: Record<string, unknown>;
	slot?: ToolSlot;
	result?: ToolResultMessage;
	/** The call is still streaming in the model's answer. */
	preparing?: boolean;
};

const STATUS_STYLE: Record<string, string> = { error: "text-err", running: "text-accent", done: "text-ok" };

export const ToolCard = memo(function ToolCard({ name, args, slot, result, preparing }: CardProps) {
	const status = result ? (result.isError ? "error" : "done") : slot ? slot.status : preparing ? "preparing" : "no result";
	const running = !result && slot?.status === "running";
	const [open, setOpen] = useState<boolean>();
	const shown = open ?? running;
	const output = result ? textOf(result.content) : (slot?.output ?? "");
	const { text, dropped } = tail(output);
	const pre = useRef<HTMLPreElement>(null);
	useLayoutEffect(() => {
		if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
	}, [text, shown]);
	const detail = toolDetail(name, args);
	return (
		<div className="min-w-0 rounded-lg border border-line bg-panel text-sm">
			<button
				type="button"
				aria-expanded={shown}
				className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left max-md:min-h-10"
				onClick={() => setOpen(!shown)}
			>
				<span className="shrink-0 font-mono font-medium">{name}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{toolSummary(name, args)}</span>
				<span className={`shrink-0 text-xs ${STATUS_STYLE[status] ?? "text-muted"} ${running ? "animate-pulse" : ""}`}>{status}</span>
			</button>
			{shown && (
				<div className="border-t border-line text-xs">
					{detail && <pre className="max-h-40 overflow-auto px-2.5 py-2 whitespace-pre-wrap text-muted">{detail}</pre>}
					{output && (
						<pre ref={pre} className="max-h-80 overflow-auto border-t border-line px-2.5 py-2 break-words whitespace-pre-wrap first:border-t-0">
							{dropped > 0 && <span className="text-muted">… {dropped} earlier lines{"\n"}</span>}
							{text}
						</pre>
					)}
				</div>
			)}
		</div>
	);
});

const card = "min-w-0 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm max-md:min-h-10";
const DELEGATION_STYLE: Record<DelegationStatus, string> = { running: "text-accent", reported: "text-ok", cancelled: "text-muted", failed: "text-err" };
const useThread = (id: number | undefined) => useStore((s) => s.snapshot?.threads.find((t) => t.id === id));
const useAgent = (key: unknown) => useStore((s) => s.snapshot?.agents.find((a) => a.id === key || a.name === key));

/** A `delegate` call: who got the work, the brief's first line, and the delegation's live status. Opens the thread. */
function DelegateCard({ args, slot, result, preparing }: CardProps) {
	const details = result?.details as DelegateDetails | undefined;
	const agent = useAgent(details?.agent ?? args?.agent);
	const info = useThread(details?.thread);
	const brief = String(args?.brief ?? "").trim().split("\n")[0];
	const reviewing = info?.status === "reviewing";
	const needed = info?.status === "needs-you";
	const status = needed
		? "needs you"
		: reviewing
			? "reviewing"
			: (info?.delegation ?? (result ? "started" : (slot?.status ?? (preparing ? "preparing" : "no result"))));
	const style = needed ? "text-warn" : reviewing ? "text-review" : info?.delegation ? DELEGATION_STYLE[info.delegation] : "text-muted";
	const body = (
		<>
			<span className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate font-medium">→ {agent?.name ?? String(details?.agent ?? args?.agent ?? "")}</span>
				{info?.review && !reviewing && <Verdict review={info.review} />}
				<span className={`shrink-0 text-xs ${style} ${info && !needed && info.status !== "idle" ? "animate-pulse" : ""}`}>{status}</span>
			</span>
			{brief && <span className="truncate text-xs text-muted">{brief}</span>}
		</>
	);
	const block = `${card} flex flex-col gap-0.5`;
	return details ? <a href={href(details.thread)} className={`${block} hover:border-muted`}>{body}</a> : <div className={block}>{body}</div>;
}

/** A `message` or `cancel` call: one line naming the target thread. Opens it. */
function ThreadCallCard({ name, args, result, slot }: CardProps) {
	const id = Number(args?.thread);
	const info = useThread(id);
	const agent = useAgent(info?.agent);
	const text = String(args?.text ?? "").split("\n")[0];
	return (
		<a href={href(id)} className={`${card} flex items-center gap-2 hover:border-muted`}>
			<span className="shrink-0 font-mono font-medium">{name}</span>
			<span className="min-w-0 shrink truncate">
				{agent && `${agent.name} · `}
				{info ? titleOf(info) : `thread ${String(args?.thread ?? "…")}`}
			</span>
			<span className="min-w-0 flex-1 truncate text-xs text-muted">
				{args?.mode === "steer" ? "steer: " : ""}
				{text}
			</span>
			<span className="shrink-0 text-xs text-muted">{result ? "done" : (slot?.status ?? "")}</span>
		</a>
	);
}

/** A `workspace` call: one line naming the thread's worktree (it has one at most). The result text, with the path, is its title. */
function WorkspaceCard({ args, result, slot, preparing }: CardProps) {
	const bound = useStore((s) => s.snapshot?.threads.find((t) => t.id === s.thread)?.branch);
	const text = result ? textOf(result.content) : "";
	const branch = bound ?? /\bbranch:?\s+`?([^\s`,;()]+)/.exec(text)?.[1].replace(/\.$/, "");
	return (
		<div title={text} className={`${card} flex items-center gap-2`}>
			<span className="min-w-0 flex-1 truncate">
				<span className="font-mono font-medium">worktree</span> · {repoLabel(String(args?.repo ?? ""))}
				{branch && ` · ${branch}`}
			</span>
			{!result && <span className="shrink-0 text-xs text-muted">{slot?.status ?? (preparing ? "preparing" : "no result")}</span>}
		</div>
	);
}

/** The open thread's agent. */
const useOwner = () => useStore((s) => s.snapshot?.agents.find((a) => a.id === s.snapshot?.threads.find((t) => t.id === s.thread)?.agent));

/** A `remember` or `notebook` call: one line. Opens the notebook. */
function NotebookCard({ name, args, result, slot }: CardProps) {
	const agent = useOwner();
	const note = String(args?.note ?? args?.text ?? "");
	return (
		<a href={agent && notebookHref(agent.id)} title={note} className={`${card} flex items-center gap-2 hover:border-muted`}>
			<span className="min-w-0 flex-1 truncate text-muted">
				{name === "remember" ? "remembered: " : "rewrote the notebook"}
				{name === "remember" && <span className="text-fg">{note.split("\n")[0]}</span>}
			</span>
			{!result && <span className="shrink-0 text-xs text-muted">{slot?.status ?? ""}</span>}
		</a>
	);
}

/** A `consult` call: whom it asked and the question's first line; the answer opens under it. */
function ConsultCard({ args, result, slot, preparing }: CardProps) {
	const agent = useAgent(args?.agent);
	const answer = result ? textOf(result.content).replace(/^\[consult [^\]]*\]\s*/, "") : "";
	const status = result ? "answered" : (slot?.status ?? (preparing ? "preparing" : "no result"));
	return (
		<details className={card}>
			<summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<span className="min-w-0 flex-1 truncate">
					<span className="text-muted">asked</span> <span className="font-medium">{agent?.name ?? String(args?.agent ?? "")}</span>:{" "}
					{String(args?.question ?? "").trim().split("\n")[0]}
				</span>
				<span className={`shrink-0 text-xs ${STATUS_STYLE[status] ?? "text-muted"} ${status === "running" ? "animate-pulse" : ""}`}>{status}</span>
			</summary>
			{answer && (
				<div className="mt-1.5 border-t border-line pt-1.5">
					<Markdown text={answer} />
				</div>
			)}
		</details>
	);
}

const CARDS: Record<string, (props: CardProps) => React.ReactNode> = {
	delegate: DelegateCard,
	message: ThreadCallCard,
	cancel: ThreadCallCard,
	workspace: WorkspaceCard,
	remember: NotebookCard,
	notebook: NotebookCard,
	consult: ConsultCard,
};

/** Input that isn't something Brian typed: a delegated thread's report, or a reviewer's findings. */
function Delivered({ ts, body, foot, children }: { ts?: number; body: string; foot?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2">
			<div className="flex items-baseline gap-2 text-xs text-muted">
				{children}
				<Time ts={ts} />
			</div>
			<Markdown text={body} />
			{foot && <div className="text-xs text-muted">{foot}</div>}
		</div>
	);
}

/** A delegated thread's report, as the supervisor received it, with the delegation's review line under it. */
function Report({ name, thread, body, review, ts }: { name: string; thread: number; body: string; review?: string; ts?: number }) {
	const info = useThread(thread);
	return (
		<Delivered ts={ts} body={body} foot={review}>
			<a href={href(thread)} className="min-w-0 flex-1 truncate hover:text-fg">
				Report from <span className="font-medium text-fg">{name}</span> · {info ? titleOf(info) : `thread ${thread}`}
			</a>
		</Delivered>
	);
}

/** A duty's wake: not something Brian typed. What the check said stays folded. */
function DutyWake({ name, body, ts }: { name: string; body: string; ts?: number }) {
	const agent = useOwner();
	return (
		<details className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted">
			<summary className="flex cursor-pointer list-none items-baseline gap-2 max-md:min-h-8 [&::-webkit-details-marker]:hidden">
				<span className="min-w-0 flex-1 truncate">
					Duty <span className="font-medium text-fg">{name}</span> woke {agent?.name ?? "the agent"}
				</span>
				<Time ts={ts} />
			</summary>
			<pre className="mt-1.5 max-h-80 overflow-auto border-t border-line pt-1.5 break-words whitespace-pre-wrap text-fg">{body}</pre>
		</details>
	);
}

/** The run in flight: the streaming answer, or what it waits on. */
export function Live({ state, calls }: { state: LiveState | undefined; calls: Calls }) {
	if (state?.run === undefined && !state?.compactions?.length) return null;
	const generation = state.generation;
	const partial = generation?.message as AssistantMessage | undefined;
	return (
		<div className="flex flex-col gap-2">
			{partial && <Assistant message={partial} calls={calls} streaming />}
			{generation?.retry && <div className="text-xs text-warn">retrying: {generation.retry.error}</div>}
			{state.compactions?.length ? <div className="text-xs text-muted animate-pulse">compacting context…</div> : null}
			{!partial && !state.tools?.length && state.run && <div className="text-sm text-muted animate-pulse">working…</div>}
		</div>
	);
}
