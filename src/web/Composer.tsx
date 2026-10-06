// Enter sends a follow-up, Shift+Enter is a newline, Alt+Enter (or the steer toggle) steers.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SendMode } from "../shared/protocol.ts";
import { abort, sendMessage } from "./store.ts";

const drafts = new Map<number, string>();

/** "1m 05s" since `since`, ticking every second while mounted. */
function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const s = Math.max(0, Math.floor((now - since) / 1000));
	const text = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
	return <span className="shrink-0 self-center font-mono text-xs text-muted tabular-nums">{text}</span>;
}

type Props = { thread: number; working: boolean; since?: number; disabled?: string };

export function Composer({ thread, working, since, disabled }: Props) {
	const [text, setTextState] = useState(() => drafts.get(thread) ?? "");
	const [steer, setSteer] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const setText = (value: string) => {
		drafts.set(thread, value);
		setTextState(value);
	};
	useLayoutEffect(() => {
		const el = box.current!;
		el.style.height = "auto";
		const height = el.scrollHeight + el.offsetHeight - el.clientHeight;
		el.style.height = `${Math.min(height, 200)}px`;
		el.style.overflowY = height > 200 ? "auto" : "hidden";
	}, [text]);

	async function submit(mode: SendMode) {
		const trimmed = text.trim();
		if (!trimmed || disabled) return;
		setText("");
		if (!(await sendMessage(thread, trimmed, mode))) setText(text);
	}

	const button = "shrink-0 rounded-lg px-3 text-sm min-h-10";
	return (
		<div className="shrink-0 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)]">
			<div className="mx-auto flex max-w-3xl items-end gap-2 px-3 py-2 md:px-6">
				<textarea
					ref={box}
					rows={1}
					value={text}
					disabled={!!disabled}
					placeholder={disabled ?? (steer ? "Steer the current run…" : "Message")}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						void submit(event.altKey || steer ? "steer" : "followUp");
					}}
					className="min-h-10 min-w-0 flex-1 resize-none rounded-lg border border-line bg-panel px-3 py-2 outline-none focus:border-accent"
				/>
				<button
					type="button"
					title="Steer: deliver at the next tool boundary instead of after the run (Alt+Enter)"
					aria-pressed={steer}
					onClick={() => setSteer(!steer)}
					className={`${button} border ${steer ? "border-accent text-accent" : "border-line text-muted"}`}
				>
					steer
				</button>
				{working && since !== undefined && <Elapsed since={since} />}
				{working && (
					<button type="button" onClick={() => void abort(thread)} className={`${button} border border-err text-err`}>
						Abort
					</button>
				)}
				<button
					type="button"
					disabled={!!disabled || !text.trim()}
					onClick={() => void submit(steer ? "steer" : "followUp")}
					className={`${button} bg-accent text-bg`}
				>
					Send
				</button>
			</div>
		</div>
	);
}
