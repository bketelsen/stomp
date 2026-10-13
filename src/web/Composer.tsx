// Enter sends a follow-up, Shift+Enter is a newline, Alt+Enter (or the steer toggle) steers. Files attach by the
// paperclip, by pasting or by dropping them on the composer.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment, SendMode } from "../shared/protocol.ts";
import { abort, sendMessage } from "./store.ts";

const drafts = new Map<number, string>();
const files = new Map<number, Attachment[]>();

/** A file as an attachment: its bytes as base64. */
async function read(file: File): Promise<Attachment> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return { name: file.name || "pasted", type: file.type, data: btoa(binary) };
}

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
	const [attached, setAttachedState] = useState(() => files.get(thread) ?? []);
	const [steer, setSteer] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const setText = (value: string) => {
		drafts.set(thread, value);
		setTextState(value);
	};
	const setAttached = (value: Attachment[]) => {
		files.set(thread, value);
		setAttachedState(value);
	};
	const add = async (list: FileList | File[] | null | undefined) => {
		if (list?.length) setAttached([...(files.get(thread) ?? []), ...(await Promise.all([...list].map(read)))]);
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
		if ((!trimmed && !attached.length) || disabled) return;
		const sending = attached;
		setText("");
		setAttached([]);
		if (!(await sendMessage(thread, trimmed, mode, sending))) setText(text), setAttached(sending);
	}

	const button = "shrink-0 rounded-lg px-3 text-sm min-h-10";
	return (
		<div
			className="shrink-0 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)]"
			onDragOver={(event) => event.preventDefault()}
			onDrop={(event) => {
				event.preventDefault();
				if (!disabled) void add(event.dataTransfer.files);
			}}
		>
			{attached.length > 0 && (
				<div className="mx-auto flex max-w-3xl flex-wrap gap-1.5 px-3 pt-2 md:px-6">
					{attached.map((file, i) => (
						<span key={`${i}-${file.name}`} className="flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-0.5 text-xs">
							<span className="max-w-48 truncate">{file.name}</span>
							<button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttached(attached.filter((_, j) => j !== i))} className="text-muted">
								×
							</button>
						</span>
					))}
				</div>
			)}
			<div className="mx-auto flex max-w-3xl items-end gap-2 px-3 py-2 md:px-6">
				<input ref={picker} type="file" multiple hidden onChange={(event) => void add(event.target.files).then(() => (event.target.value = ""))} />
				<button type="button" title="Attach files (or paste or drop them)" disabled={!!disabled} onClick={() => picker.current?.click()} className={`${button} border border-line text-muted`}>
					📎
				</button>
				<textarea
					ref={box}
					rows={1}
					value={text}
					disabled={!!disabled}
					placeholder={disabled ?? (steer ? "Steer the current run…" : "Message")}
					onChange={(event) => setText(event.target.value)}
					onPaste={(event) => {
						if (!event.clipboardData.files.length) return;
						event.preventDefault();
						void add(event.clipboardData.files);
					}}
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
					disabled={!!disabled || (!text.trim() && !attached.length)}
					onClick={() => void submit(steer ? "steer" : "followUp")}
					className={`${button} bg-accent text-bg`}
				>
					Send
				</button>
			</div>
		</div>
	);
}
