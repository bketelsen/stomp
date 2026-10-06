// The open thread: history, the live run, queued input and the composer.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { AskCard } from "./Ask.tsx";
import { Composer } from "./Composer.tsx";
import { type Calls, Entry, Live } from "./Entry.tsx";
import { clearError, loadEarlier, useStore } from "./store.ts";
import { dutyOf, fixOf, inbox, live, message, reportOf, textOf, type ToolResultMessage } from "./view.ts";

export function Thread({ disabled }: { disabled?: string }) {
	const thread = useStore((s) => s.thread);
	const view = useStore((s) => s.view);
	const older = useStore((s) => s.older);
	const olderDone = useStore((s) => s.olderDone);
	const error = useStore((s) => s.error);
	const asks = useStore((s) => s.snapshot?.asks);

	const entries = useMemo(() => [...older, ...(view?.entries ?? [])], [older, view?.entries]);
	const liveState = live(view);
	const tools = liveState?.tools;
	const calls = useMemo<Calls>(() => {
		const called = new Set<string>();
		const results = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			const m = message(entry);
			if (m?.role === "assistant") for (const block of m.content) if (block.type === "toolCall") called.add(block.id);
			if (m?.role === "toolResult") results.set(m.toolCallId, m);
		}
		return { called, results, slots: new Map((tools ?? []).map((slot) => [slot.callId, slot])) };
	}, [entries, tools]);
	const queued = inbox(view);
	const working = liveState?.run !== undefined;
	// The run's start: pi-durable records none, so use the input that started it.
	const since = useMemo(() => {
		for (let i = entries.length - 1; i >= 0; i--) {
			const m = message(entries[i]!);
			if (m?.role === "user") return m.timestamp;
		}
		return undefined;
	}, [entries]);
	// History older than the view exists when the view starts at a head marker: a compaction or a reset.
	const canLoadEarlier = !olderDone && (older.length > 0 || view?.entries[0]?.head !== undefined);

	// Follow the bottom while the reader is there; keep their place when older history is prepended.
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const height = useRef(0);
	const first = useRef<number>(undefined);
	useLayoutEffect(() => {
		stick.current = true;
	}, [thread]);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		if (stick.current) el.scrollTop = el.scrollHeight;
		else if (entries[0]?.id !== first.current) el.scrollTop += el.scrollHeight - height.current;
		first.current = entries[0]?.id;
		height.current = el.scrollHeight;
	});
	// Reflows (a narrower window, the keyboard, a growing composer) keep the bottom too. Scroll anchoring is off, so
	// only the reader's own scrolling unsticks.
	useEffect(() => {
		const el = scroller.current!;
		const observer = new ResizeObserver(() => {
			if (stick.current) el.scrollTop = el.scrollHeight;
		});
		observer.observe(el);
		observer.observe(el.firstElementChild!);
		return () => observer.disconnect();
	}, []);
	const onScroll = () => {
		const el = scroller.current!;
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
		height.current = el.scrollHeight;
	};

	return (
		<>
			<div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
				<div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 py-4 md:px-6">
					{thread === undefined && <p className="text-muted">Pick a thread.</p>}
					{thread !== undefined && view === undefined && !error && <p className="text-muted">Loading…</p>}
					{canLoadEarlier && (
						<button type="button" onClick={() => void loadEarlier()} className="self-center rounded-full border border-line px-3 py-1 text-sm text-muted hover:text-fg max-md:min-h-10">
							Load earlier
						</button>
					)}
					{entries.map((entry) => (
						<Entry key={entry.id} entry={entry} calls={calls} />
					))}
					<Live state={liveState} calls={calls} />
					{asks?.map((ask) => ask.thread === thread && <AskCard key={ask.id} ask={ask} />)}
				</div>
			</div>
			<div className="mx-auto w-full max-w-3xl px-3 md:px-6">
				{queued.map((item) => {
					if (item.mode === "write") return null;
					const text = textOf(item.content);
					const report = reportOf(text);
					const fix = fixOf(text);
					const duty = dutyOf(text);
					const label = report ? `report from ${report.name}` : fix ? "review" : duty ? `duty ${duty.name}` : item.mode === "steer" ? "steer" : "queued";
					return (
						<div key={item.id} className="mb-1.5 flex gap-2 rounded-lg border border-dashed border-line px-3 py-1.5 text-sm">
							<span className="shrink-0 text-xs text-muted">{label}</span>
							<span className="min-w-0 truncate">{(report ?? fix ?? duty)?.body ?? text}</span>
						</div>
					);
				})}
				{error && (
					<div className="mb-1.5 flex items-start gap-2 rounded-lg bg-err/10 px-3 py-1.5 text-sm text-err">
						<span className="min-w-0 flex-1 break-words">{error}</span>
						<button type="button" onClick={clearError} aria-label="Dismiss" className="shrink-0 px-1 max-md:min-h-10 max-md:min-w-10">
							×
						</button>
					</div>
				)}
			</div>
			{thread !== undefined && <Composer key={thread} thread={thread} working={working} since={since} disabled={disabled} />}
		</>
	);
}
