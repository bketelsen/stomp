// Layout and routing: the rail, a thin top bar, the open thread and the Work panel. `#/thread/<id>` picks the thread;
// `#/agent/<id>/notebook` shows an agent's notebook and duties instead.
import { useEffect, useState } from "react";
import { Notebook } from "./Notebook.tsx";
import { Rail } from "./Rail.tsx";
import { Verdict } from "./Review.tsx";
import { select, useStore } from "./store.ts";
import { Thread } from "./Thread.tsx";
import { delegator, href, repoLabel, titleOf, tokens, usageOf } from "./view.ts";
import { Work } from "./Work.tsx";

/** Tailwind's `md`, where Work is a panel; below it, Work is a sheet. */
const wide = () => matchMedia("(min-width: 48rem)").matches;

const routed = () => {
	const match = /^#\/thread\/(\d+)$/.exec(location.hash);
	return match ? Number(match[1]) : undefined;
};
const notebookOf = () => {
	const match = /^#\/agent\/([^/]+)\/notebook$/.exec(location.hash);
	return match ? decodeURIComponent(match[1]!) : undefined;
};

export function App() {
	const snapshot = useStore((s) => s.snapshot);
	const thread = useStore((s) => s.thread);
	const view = useStore((s) => s.view);
	const connected = useStore((s) => s.connected);
	const [notebook, setNotebook] = useState(notebookOf);
	const [railOpen, setRailOpen] = useState(false);
	const [panel, setPanel] = useState(true);
	const [sheet, setSheet] = useState(false);
	const toggleWork = (open: boolean) => (wide() ? setPanel(open) : setSheet(open));

	useEffect(() => {
		const onHash = () => {
			select(routed());
			setNotebook(notebookOf());
			setRailOpen(false);
			setSheet(false);
		};
		onHash();
		addEventListener("hashchange", onHash);
		return () => removeEventListener("hashchange", onHash);
	}, []);

	// No thread in the URL: open the supervisor's desk.
	useEffect(() => {
		const home = snapshot?.agents.find((a) => a.role === "supervisor" && !a.error) ?? snapshot?.agents.find((a) => !a.error);
		if (routed() === undefined && notebookOf() === undefined && home) location.replace(`#/thread/${home.deskThread}`);
	}, [snapshot]);

	const info = snapshot?.threads.find((t) => t.id === thread);
	const agent = snapshot?.agents.find((a) => a.id === (notebook ?? info?.agent));
	const usage = usageOf(view);
	const needed = new Set(snapshot?.agents.filter((a) => !a.error).map((a) => a.provider));
	const missing = snapshot?.providers.filter((p) => !p.loggedIn && needed.has(p.id)) ?? [];
	const busy = snapshot?.threads.filter((t) => t.status !== "idle" || t.delegation === "running").length ?? 0;
	const asks = snapshot?.asks?.length ?? 0;
	const toReview = () => [...document.querySelectorAll("[data-review]")].at(-1)?.scrollIntoView({ behavior: "smooth", block: "start" });

	return (
		<div className="flex h-dvh">
			<Rail open={railOpen} notebook={notebook} onClose={() => setRailOpen(false)} />
			<main className="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)] md:pt-0">
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2 md:px-4">
					<button type="button" aria-label="Threads" onClick={() => setRailOpen(true)} className="size-10 shrink-0 rounded-md text-lg md:hidden">
						☰
					</button>
					{/* On phone the agent, delegation and branch drop to a second line, and the thread's usage gives way to the work button. */}
					<div className="flex min-w-0 flex-1 flex-col md:flex-row md:items-baseline md:gap-2">
						<span className="truncate leading-tight font-medium md:leading-normal">{info ? titleOf(info) : notebook ? "notebook" : "stomp"}</span>
						<span className="flex min-w-0 items-baseline gap-2 overflow-hidden text-xs text-muted md:shrink-[3] md:text-sm">
							{agent && (
								<span className="shrink-0" title={agent.provider && `${agent.provider} · ${agent.modelId} (${agent.family})`}>
									{agent.name}
								</span>
							)}
							{info?.delegatedBy !== undefined && (
								<a href={href(info.delegatedBy)} className="truncate underline-offset-2 hover:text-fg hover:underline">
									delegated by {delegator(snapshot, info)?.name ?? "supervisor"}
								</a>
							)}
							{info?.repo && (
								<span className="shrink-[4] truncate font-mono text-xs" title={[info.repo, info.branch].filter(Boolean).join(" · ")}>
									{repoLabel(info.repo)}
									{info.branch && ` · ${info.branch}`}
								</span>
							)}
						</span>
					</div>
					{info?.status === "reviewing" ? (
						<span className="shrink-0 animate-pulse text-xs text-review">reviewing</span>
					) : (
						info?.review && <Verdict review={info.review} onClick={toReview} />
					)}
					{usage && (
						<span className="shrink-0 text-xs text-muted max-md:hidden" title="tokens in (cache included) · out">
							{tokens(usage.input)} in · {tokens(usage.output)} out
						</span>
					)}
					{!connected && <span className="shrink-0 text-xs text-warn">reconnecting…</span>}
					<button
						type="button"
						onClick={() => toggleWork(wide() ? !panel : !sheet)}
						className="shrink-0 rounded-md px-2 text-sm text-muted hover:text-fg max-md:min-h-10"
					>
						work
						{asks > 0 ? (
							<span title={`${asks} waiting for you`} className="ml-1.5 rounded-full bg-warn px-1.5 text-xs leading-5 font-semibold text-bg tabular-nums">
								{asks}
							</span>
						) : (
							busy > 0 && <span className="ml-1 text-accent tabular-nums">{busy}</span>
						)}
					</button>
				</header>
				{missing.map((p) => (
					<div key={p.id} className="shrink-0 border-b border-line bg-warn/10 px-4 py-1 text-xs text-warn">
						{p.id} is not logged in. run: <code>npm run login {p.id}</code>
					</div>
				))}
				{notebook === undefined ? (
					<Thread disabled={agent?.error ? `${agent.name} failed to load` : undefined} />
				) : (
					agent && <Notebook key={agent.id} agent={agent} />
				)}
			</main>
			<Work panel={panel} sheet={sheet} onClose={() => toggleWork(false)} />
		</div>
	);
}
