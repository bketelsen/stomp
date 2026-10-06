// Asks: commands the judge didn't clear, waiting for Brian. The card in the thread, the row in Work, and the bell that
// lets the browser tell him.
import { useState } from "react";
import type { Ask, AskAnswer } from "../shared/protocol.ts";
import { Time } from "./Entry.tsx";
import { answerAsk, useStore } from "./store.ts";
import { href, titleOf } from "./view.ts";

const useAgentName = (id: string) => useStore((s) => s.snapshot?.agents.find((a) => a.id === id)?.name ?? id);

const button = "min-h-11 rounded-lg px-3 text-sm md:min-h-9";

/** An ask at the bottom of its thread: the whole command, where it runs, why it asks, and one tap to answer. */
export function AskCard({ ask }: { ask: Ask }) {
	const name = useAgentName(ask.agent);
	const [busy, setBusy] = useState(false);
	const [denying, setDenying] = useState(false);
	const [note, setNote] = useState("");
	// The card goes when the state no longer has the ask; only a failed answer re-enables it.
	const answer = async (decision: AskAnswer["decision"]) => {
		setBusy(true);
		const reason = decision === "deny" ? note.trim() : "";
		if (!(await answerAsk(ask.id, reason ? { decision, note: reason } : { decision }))) setBusy(false);
	};
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-warn/50 bg-panel px-3 py-2.5">
			<div className="flex items-baseline gap-2 text-xs">
				<span className="shrink-0 font-medium text-warn">needs you</span>
				<span className="min-w-0 flex-1 break-words text-muted">{ask.why}</span>
				<Time ts={ask.createdAt} />
			</div>
			<pre className="text-sm whitespace-pre-wrap wrap-anywhere">{ask.command}</pre>
			{ask.cwd && <div className="font-mono text-xs text-muted wrap-anywhere">{ask.cwd}</div>}
			{denying ? (
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void answer("deny");
					}}
				>
					<input
						autoFocus
						value={note}
						disabled={busy}
						enterKeyHint="send"
						placeholder={`Note for ${name}`}
						onChange={(event) => setNote(event.target.value)}
						onKeyDown={(event) => event.key === "Escape" && setDenying(false)}
						className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm outline-none focus:border-accent md:min-h-9"
					/>
					<button type="submit" disabled={busy} className={`${button} border border-err text-err`}>
						Deny
					</button>
					<button type="button" aria-label="Back" onClick={() => setDenying(false)} className={`${button} text-muted hover:text-fg max-md:min-w-11`}>
						×
					</button>
				</form>
			) : (
				// On a phone: Allow and Deny side by side, Always across under them.
				<div className="grid grid-flow-row-dense grid-cols-2 gap-2 md:flex">
					<button type="button" disabled={busy} onClick={() => void answer("allow")} className={`${button} bg-accent text-bg`}>
						Allow
					</button>
					{!ask.once && (
						<button
							type="button"
							disabled={busy}
							title={`Allow, and from now on run commands like this for ${name} without asking`}
							onClick={() => void answer("always")}
							className={`${button} col-span-2 border border-line hover:border-muted`}
						>
							Always allow for {name}
						</button>
					)}
					<button type="button" disabled={busy} onClick={() => setDenying(true)} className={`${button} border border-line text-err hover:border-err`}>
						Deny
					</button>
				</div>
			)}
		</div>
	);
}

/** An ask in Work: who's asking, from which thread, how long ago, and the command. Opens the thread. */
export function AskRow({ ask, current }: { ask: Ask; current: boolean }) {
	const name = useAgentName(ask.agent);
	const thread = useStore((s) => s.snapshot?.threads.find((t) => t.id === ask.thread));
	return (
		<a href={href(ask.thread)} className={`flex flex-col rounded-md px-2 py-1.5 text-sm max-md:min-h-10 ${current ? "bg-line" : "hover:bg-line/50"}`}>
			<span className="flex items-baseline gap-2">
				<span className="min-w-0 flex-1 truncate">
					{name}
					{thread && <span className="text-muted"> · {titleOf(thread)}</span>}
				</span>
				<Time ts={ask.createdAt} />
			</span>
			<code className="truncate text-xs">{ask.command.split("\n")[0]}</code>
		</a>
	);
}

const BELL = "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0";
const BELL_TITLE = { default: "Notify me of new asks", granted: "New asks notify you", denied: "Notifications are blocked in site settings" };

/** Asks the browser for notifications only when tapped. Once they're on (or blocked) it's a quiet marker. */
export function Bell() {
	const [permission, setPermission] = useState(() => (typeof Notification === "undefined" ? undefined : Notification.permission));
	if (permission === undefined) return null;
	return (
		<button
			type="button"
			title={BELL_TITLE[permission]}
			aria-label={BELL_TITLE[permission]}
			aria-disabled={permission !== "default"}
			onClick={() => permission === "default" && void Notification.requestPermission().then(setPermission)}
			className={`grid size-10 place-items-center rounded-md ${{ default: "text-muted hover:text-fg", granted: "text-accent", denied: "text-muted opacity-50" }[permission]}`}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
				<path d={BELL} />
			</svg>
		</button>
	);
}
