// The supervisor, then the agents, each with its title, threads and notebook, and a fold. Delegated threads say who
// delegated them and how it went; threads with work Brian hasn't seen have an unread dot. Archived threads wait behind
// "archived" unless they need Brian, have news or are open.
import { useState } from "react";
import type { AgentInfo, DelegationStatus, ThreadInfo, ThreadStatus } from "../shared/protocol.ts";
import { archive, newThread, toggleAgent, useStore } from "./store.ts";
import { delegator, href, notebookHref, titleOf } from "./view.ts";

const SHOWN = 6;

/** Amber while it needs you; pulses while working or reviewing; a delegation running but idle (to report) is a steady dot. */
function Dot({ status, delegation }: { status: ThreadStatus; delegation?: DelegationStatus }) {
	if (status === "needs-you") return <span title="needs you" className="size-2 shrink-0 rounded-full bg-warn ring-2 ring-warn/30" />;
	if (status === "working") return <span title="working" className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />;
	if (status === "reviewing") return <span title="reviewing" className="size-2 shrink-0 animate-pulse rounded-full bg-review" />;
	if (delegation === "running") return <span title="delegated, running" className="size-2 shrink-0 rounded-full bg-accent" />;
	return <span title="idle" className="size-2 shrink-0 rounded-full border border-muted" />;
}

/** Work Brian hasn't seen. */
export const Unread = () => <span title="unread" className="size-1.5 shrink-0 rounded-full bg-accent" />;

function From({ thread }: { thread: ThreadInfo }) {
	const name = useStore((s) => delegator(s.snapshot, thread)?.name);
	return (
		<span className="truncate text-xs text-muted">
			from {name ?? "supervisor"}
			{thread.delegation && thread.delegation !== "running" && ` · ${thread.delegation}`}
		</span>
	);
}

const icon = "size-3.5 shrink-0";
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** A fold's chevron, pointing down while open. */
const Chevron = ({ open }: { open: boolean }) => (
	<svg viewBox="0 0 24 24" {...stroke} className={`${icon} transition-transform ${open ? "rotate-90" : ""}`}>
		<path d="m9 6 6 6-6 6" />
	</svg>
);

/** An archive box; `out`, with an arrow coming out of it. */
const Box = ({ out }: { out?: boolean }) => (
	<svg viewBox="0 0 24 24" {...stroke} className={icon}>
		<rect x="3" y="4" width="18" height="4" rx="1" />
		<path d={`M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8${out ? "M12 17v-6m-3 3 3-3 3 3" : "M10 12h4"}`} />
	</svg>
);

const row = "flex items-center gap-2 rounded-md px-2 py-1 text-sm max-md:min-h-10";

/** A thread, and a button to archive it or bring it back: on hover on desktop, always on a phone. Desks stay. */
function Row({ thread, current, unread }: { thread: ThreadInfo; current: boolean; unread: boolean }) {
	return (
		<div className={`group flex items-center rounded-md ${current ? "bg-line text-fg" : "text-muted hover:bg-line/50 hover:text-fg"}`}>
			<a href={href(thread.id)} className={`${row} min-w-0 flex-1`}>
				<Dot status={thread.status} delegation={thread.delegation} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className={`truncate ${unread ? "font-medium text-fg" : ""}`}>{titleOf(thread)}</span>
					{thread.delegatedBy !== undefined && <From thread={thread} />}
				</span>
				{unread && <Unread />}
			</a>
			{!thread.desk && (
				<button
					type="button"
					title={thread.archived ? "unarchive" : "archive"}
					aria-label={`${thread.archived ? "Unarchive" : "Archive"} ${titleOf(thread)}`}
					onClick={() => void archive(thread.id, !thread.archived)}
					className={`shrink-0 rounded-md px-1.5 text-muted hover:text-fg max-md:min-h-10 ${current ? "" : "md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"}`}
				>
					<Box out={thread.archived} />
				</button>
			)}
		</div>
	);
}

function Agent({ agent, threads, current, notebook }: { agent: AgentInfo; threads: ThreadInfo[]; current?: number; notebook: boolean }) {
	const [all, setAll] = useState(false);
	const [stored, setStored] = useState(false);
	const unread = useStore((s) => s.unread);
	const folded = useStore((s) => s.collapsed.includes(agent.id));
	// Found by review: past the first few, or archived, a thread still shows while it's open, needs Brian or has news.
	const keep = (t: ThreadInfo) => t.id === current || t.status === "needs-you" || unread.includes(t.id);
	const active = threads.filter((t) => !t.archived || keep(t));
	const archived = threads.filter((t) => t.archived && !keep(t));
	const fold = (
		<button
			type="button"
			aria-label={`${folded ? "Show" : "Hide"} ${agent.name}'s threads`}
			aria-expanded={!folded}
			onClick={() => toggleAgent(agent.id)}
			className="flex shrink-0 items-start rounded-md px-1 pt-3 text-muted hover:text-fg max-md:min-w-10 max-md:justify-center"
		>
			<Chevron open={!folded} />
		</button>
	);
	const header = (
		<>
			<span className="flex min-w-0 items-center gap-2">
				{agent.error ? <span className="size-2 shrink-0 rounded-full bg-err" /> : <Dot status={agent.status} />}
				<span className="truncate font-medium">{agent.name}</span>
				{agent.title && (
					<span className="shrink-[3] truncate text-sm text-muted" title={agent.title}>
						{agent.title}
					</span>
				)}
				{folded && threads.some((t) => unread.includes(t.id)) && <Unread />}
			</span>
			{agent.model && (
				<span className="truncate pl-4 text-xs text-muted" title={agent.family}>
					{agent.provider} · {agent.modelId || agent.model}
				</span>
			)}
		</>
	);
	if (agent.error)
		return (
			<div className="flex">
				{fold}
				<div className="flex min-w-0 flex-col px-2 py-1.5" title={agent.error}>
					{header}
					{!folded && <span className="pl-4 text-xs break-words text-err">{agent.error}</span>}
				</div>
			</div>
		);
	return (
		<div className="flex flex-col">
			<div className="flex">
				{fold}
				<a href={href(agent.deskThread)} className="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 hover:bg-line/50 max-md:min-h-10">
					{header}
				</a>
			</div>
			{!folded && (
				<div className="flex flex-col pl-6">
					{active.filter((t, i) => all || i < SHOWN || keep(t)).map((thread) => (
						<Row key={thread.id} thread={thread} current={thread.id === current} unread={unread.includes(thread.id)} />
					))}
					{active.length > SHOWN && (
						<button type="button" onClick={() => setAll(!all)} className={`${row} text-xs text-muted hover:text-fg`}>
							{all ? "fewer" : `${active.length - SHOWN} more`}
						</button>
					)}
					<span className="flex">
						<button type="button" onClick={() => void newThread(agent.id)} className={`${row} text-xs text-muted hover:text-fg`}>
							+ thread
						</button>
						<a href={notebookHref(agent.id)} className={`${row} text-xs ${notebook ? "bg-line text-fg" : "text-muted hover:text-fg"}`}>
							notebook
						</a>
						{archived.length > 0 && (
							<button
								type="button"
								aria-expanded={stored}
								onClick={() => setStored(!stored)}
								className={`${row} text-xs ${stored ? "bg-line text-fg" : "text-muted hover:text-fg"}`}
							>
								archived {archived.length}
							</button>
						)}
					</span>
					{stored && archived.map((thread) => <Row key={thread.id} thread={thread} current={false} unread={false} />)}
				</div>
			)}
		</div>
	);
}

export function Rail({ open, notebook, onClose }: { open: boolean; notebook?: string; onClose: () => void }) {
	const snapshot = useStore((s) => s.snapshot);
	const current = useStore((s) => s.thread);
	const agents = [...(snapshot?.agents ?? [])].sort((a, b) => Number(b.role === "supervisor") - Number(a.role === "supervisor"));
	const threadsOf = (agent: string) =>
		(snapshot?.threads ?? []).filter((t) => t.agent === agent).sort((a, b) => Number(b.desk) - Number(a.desk) || b.createdAt - a.createdAt);
	return (
		<>
			{open && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={onClose} />}
			<nav
				className={`fixed inset-y-0 left-0 z-30 flex w-72 shrink-0 flex-col border-r border-line bg-panel pt-[env(safe-area-inset-top)] transition-transform md:static md:z-auto md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
			>
				<div className="flex h-11 shrink-0 items-center px-4 font-semibold tracking-tight">stomp</div>
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-4">
					{snapshot === undefined && <p className="px-2 text-sm text-muted">Connecting…</p>}
					{agents.map((agent) => (
						<Agent key={agent.id} agent={agent} threads={threadsOf(agent.id)} current={current} notebook={agent.id === notebook} />
					))}
				</div>
			</nav>
		</>
	);
}
