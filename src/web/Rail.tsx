// The supervisor, then the agents, each with its threads and notebook. Delegated threads say who delegated them and how
// it went; threads with work Brian hasn't seen have an unread dot.
import { useState } from "react";
import type { AgentInfo, DelegationStatus, ThreadInfo, ThreadStatus } from "../shared/protocol.ts";
import { newThread, useStore } from "./store.ts";
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

function Agent({ agent, threads, current, notebook }: { agent: AgentInfo; threads: ThreadInfo[]; current?: number; notebook: boolean }) {
	const [all, setAll] = useState(false);
	const unread = useStore((s) => s.unread);
	const header = (
		<>
			<span className="flex items-center gap-2">
				{agent.error ? <span className="size-2 shrink-0 rounded-full bg-err" /> : <Dot status={agent.status} />}
				<span className="truncate font-medium">{agent.name}</span>
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
			<div className="flex flex-col px-2 py-1.5" title={agent.error}>
				{header}
				<span className="pl-4 text-xs break-words text-err">{agent.error}</span>
			</div>
		);
	const row = "flex items-center gap-2 rounded-md px-2 py-1 text-sm max-md:min-h-10";
	return (
		<div className="flex flex-col">
			<a href={href(agent.deskThread)} className="flex flex-col rounded-md px-2 py-1.5 hover:bg-line/50 max-md:min-h-10">
				{header}
			</a>
			<div className="flex flex-col pl-4">
				{threads.filter((t, i) => all || i < SHOWN || unread.includes(t.id)).map((thread) => (
					<a
						key={thread.id}
						href={href(thread.id)}
						className={`${row} ${thread.id === current ? "bg-line text-fg" : "text-muted hover:bg-line/50 hover:text-fg"}`}
					>
						<Dot status={thread.status} delegation={thread.delegation} />
						<span className="flex min-w-0 flex-1 flex-col">
							<span className={`truncate ${unread.includes(thread.id) ? "font-medium text-fg" : ""}`}>{titleOf(thread)}</span>
							{thread.delegatedBy !== undefined && <From thread={thread} />}
						</span>
						{unread.includes(thread.id) && <Unread />}
					</a>
				))}
				{threads.length > SHOWN && (
					<button type="button" onClick={() => setAll(!all)} className={`${row} text-xs text-muted hover:text-fg`}>
						{all ? "fewer" : `${threads.length - SHOWN} more`}
					</button>
				)}
				<span className="flex">
					<button type="button" onClick={() => void newThread(agent.id)} className={`${row} text-xs text-muted hover:text-fg`}>
						+ thread
					</button>
					<a href={notebookHref(agent.id)} className={`${row} text-xs ${notebook ? "bg-line text-fg" : "text-muted hover:text-fg"}`}>
						notebook
					</a>
				</span>
			</div>
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
