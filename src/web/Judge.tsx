// The judge's feed: its latest decisions, newest first. Quiet on purpose; it's there to check the judge by, not to call
// for attention.
import { useEffect, useState } from "react";
import type { JudgeDecision } from "../shared/protocol.ts";
import { judgeLog, useStore } from "./store.ts";
import { ago, href, useNow } from "./view.ts";

const SHOWN = 30;
const ANSWERED: Record<NonNullable<JudgeDecision["answer"]>, string> = { allow: "allowed", always: "always allowed", deny: "denied" };

/** Collapsed until opened; loads when opened and again whenever the asks change. */
export function Judge() {
	const [open, setOpen] = useState(false);
	const [decisions, setDecisions] = useState<JudgeDecision[]>();
	const [failed, setFailed] = useState<string>();
	const asks = useStore((s) => (s.snapshot?.asks ?? []).map((ask) => ask.id).join());
	const agents = useStore((s) => s.snapshot?.agents);
	const now = useNow();
	useEffect(() => {
		if (!open) return;
		let current = true;
		judgeLog(SHOWN).then(
			(list) => current && (setDecisions(list), setFailed(undefined)),
			(error: Error) => current && setFailed(error.message),
		);
		return () => {
			current = false;
		};
	}, [open, asks]);
	return (
		<details onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className="cursor-pointer px-2 pb-0.5 text-xs text-muted select-none hover:text-fg">Judge</summary>
			{failed && <p className="px-2 text-xs text-muted">Couldn't load the judge's log: {failed}</p>}
			{decisions?.length === 0 && <p className="px-2 text-xs text-muted">No decisions yet.</p>}
			{decisions?.map((d, i) => (
				<a key={`${d.at}:${i}`} href={href(d.thread)} title={d.command} className="flex flex-col rounded-md px-2 py-1 text-xs text-muted hover:bg-line/50">
					<span className="flex items-baseline gap-2">
						<span className={`shrink-0 rounded px-1 ${d.outcome === "ask" ? "bg-warn/10 text-warn" : "bg-line"}`}>{d.outcome}</span>
						<code className="min-w-0 flex-1 truncate text-fg">{d.command.split("\n")[0]}</code>
						<time className="shrink-0" title={new Date(d.at).toLocaleString()}>
							{ago(d.at, now)}
						</time>
					</span>
					{/* The detail (a rule, or the judge's probabilities) gives way first. */}
					<span className="flex gap-1">
						<span className="shrink-0">
							{agents?.find((a) => a.id === d.agent)?.name ?? d.agent} · {d.by}
							{d.ms !== undefined && ` · ${d.ms} ms`}
							{d.answer && ` · ${ANSWERED[d.answer]}`}
						</span>
						{d.detail && <span className="truncate" title={d.detail}>· {d.detail}</span>}
					</span>
				</a>
			))}
		</details>
	);
}
