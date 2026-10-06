// Work: asks first, threads grouped by derived state (unread ones stay under "Recently done" until opened), the judge's
// feed, and tokens per provider. A right-hand panel on desktop, a sheet on phone.
import type { ThreadInfo } from "../shared/protocol.ts";
import { AskRow, Bell } from "./Ask.tsx";
import { Judge } from "./Judge.tsx";
import { verdictLabel } from "./Review.tsx";
import { Unread } from "./Rail.tsx";
import { useStore } from "./store.ts";
import { ago, href, titleOf, tokens, useNow } from "./view.ts";

const RECENT = 5;

/** What the Work panel lists, newest first. */
function groups(threads: readonly ThreadInfo[], unread: readonly number[]): [string, ThreadInfo[]][] {
	const sorted = [...threads].sort((a, b) => b.createdAt - a.createdAt);
	const idle = sorted.filter((t) => t.status === "idle");
	const recent = new Set(idle.filter((t) => t.delegation && t.delegation !== "running").slice(0, RECENT));
	return [
		["Working", sorted.filter((t) => t.status === "working")],
		["Reviewing", sorted.filter((t) => t.status === "reviewing")],
		["Delegated, running", idle.filter((t) => t.delegation === "running")],
		["Recently done", idle.filter((t) => recent.has(t) || (unread.includes(t.id) && t.delegation !== "running"))],
	];
}

function Row({ thread, current }: { thread: ThreadInfo; current: boolean }) {
	const now = useNow();
	const agent = useStore((s) => s.snapshot?.agents.find((a) => a.id === thread.agent)?.name);
	const done = thread.delegation && thread.delegation !== "running";
	const unread = useStore((s) => s.unread.includes(thread.id));
	return (
		<a href={href(thread.id)} className={`flex flex-col rounded-md px-2 py-1.5 text-sm max-md:min-h-10 ${current ? "bg-line" : "hover:bg-line/50"}`}>
			<span className="flex items-baseline gap-2">
				<span className={`min-w-0 flex-1 truncate ${unread ? "font-medium" : ""}`}>{titleOf(thread)}</span>
				{unread && <Unread />}
				<time className="shrink-0 text-xs text-muted" title={new Date(thread.createdAt).toLocaleString()}>
					{ago(thread.createdAt, now)}
				</time>
			</span>
			<span className="truncate text-xs text-muted">
				{agent ?? thread.agent}
				{done && ` · ${thread.delegation}`}
				{thread.review && ` · ${verdictLabel(thread.review)}`}
			</span>
		</a>
	);
}

/** `panel`: shown on desktop; `sheet`: shown on phone. */
export function Work({ panel, sheet, onClose }: { panel: boolean; sheet: boolean; onClose: () => void }) {
	const snapshot = useStore((s) => s.snapshot);
	const current = useStore((s) => s.thread);
	const unread = useStore((s) => s.unread);
	const shown = groups(snapshot?.threads ?? [], unread).filter(([, threads]) => threads.length > 0);
	const usage = snapshot?.usage ?? [];
	const asks = snapshot?.asks ?? [];
	return (
		<>
			{sheet && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={onClose} />}
			<aside
				className={`fixed inset-x-0 bottom-0 z-30 flex max-h-[80dvh] flex-col rounded-t-2xl border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] transition-transform md:static md:max-h-none md:w-72 md:shrink-0 md:rounded-none md:border-t-0 md:border-l md:translate-y-0 md:pb-0 ${sheet ? "" : "translate-y-full"} ${panel ? "" : "md:hidden"}`}
			>
				<div className="flex h-11 shrink-0 items-center pl-4 pr-1 font-semibold tracking-tight">
					<span className="flex-1">Work</span>
					<Bell />
					<button type="button" aria-label="Close work" onClick={onClose} className="size-10 rounded-md font-normal text-muted hover:text-fg">
						×
					</button>
				</div>
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3">
					{shown.length === 0 && asks.length === 0 && <p className="px-2 text-sm text-muted">Nothing running.</p>}
					{asks.length > 0 && (
						<section className="flex flex-col">
							<h2 className="px-2 pb-0.5 text-xs font-medium text-warn">Needs you</h2>
							{asks.map((ask) => (
								<AskRow key={ask.id} ask={ask} current={ask.thread === current} />
							))}
						</section>
					)}
					{shown.map(([label, threads]) => (
						<section key={label} className="flex flex-col">
							<h2 className="px-2 pb-0.5 text-xs text-muted">{label}</h2>
							{threads.map((thread) => (
								<Row key={thread.id} thread={thread} current={thread.id === current} />
							))}
						</section>
					))}
					<Judge />
				</div>
				{usage.length > 0 && (
					<div className="shrink-0 border-t border-line px-4 py-2 text-xs text-muted" title="tokens since the store was created: in (cache included) · out">
						{usage.map((u) => (
							<div key={u.provider} className="flex gap-2">
								<span className="min-w-0 flex-1 truncate">{u.provider}</span>
								<span className="shrink-0 tabular-nums">
									{tokens(u.input)} in · {tokens(u.output)} out
								</span>
							</div>
						))}
					</div>
				)}
			</aside>
		</>
	);
}
