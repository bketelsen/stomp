// An agent's page: its notebook, as markdown and editable, and its duties, read-only (they're in the agent file, or the
// supervisor's duties.yaml).
import { useEffect, useState } from "react";
import type { AgentInfo, DutyInfo } from "../shared/protocol.ts";
import { Markdown } from "./markdown.tsx";
import { notebook, saveNotebook, useStore } from "./store.ts";
import { ago, ahead, href, useNow } from "./view.ts";

const button = "min-h-10 rounded-lg px-3 text-sm md:min-h-8";

export function Notebook({ agent }: { agent: AgentInfo }) {
	const [text, setText] = useState<string>();
	/** Set while editing, with the text it started from: a save goes through only over that text. */
	const [draft, setDraft] = useState<{ text: string; base: string; from: number }>();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<string>();
	// Loads again when the agent writes to it, unless Brian is editing.
	useEffect(() => {
		if (draft) return;
		let current = true;
		notebook(agent.id).then(
			(t) => current && (setText(t), setFailed(undefined)),
			(error: Error) => current && setFailed(`Couldn't load the notebook: ${error.message}`),
		);
		return () => {
			current = false;
		};
	}, [agent.id, agent.notes, !draft]);
	const save = async () => {
		setBusy(true);
		await saveNotebook(agent.id, draft!.text, draft!.base).then(
			() => (setText(draft!.text), setDraft(undefined), setFailed(undefined)),
			(error: Error) => setFailed(`Couldn't save: ${error.message}. Your edit is still here; copy it, cancel to see the new notes, and edit again.`),
		);
		setBusy(false);
	};
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-4 md:px-6">
				<div className="flex items-center gap-2">
					<h2 className="font-medium">Notebook</h2>
					<span className="flex-1 text-xs text-muted">{agent.notes === 1 ? "1 line" : `${agent.notes} lines`}</span>
					{draft && (
						<button type="button" disabled={busy} onClick={() => setDraft(undefined)} className={`${button} text-muted hover:text-fg`}>
							Cancel
						</button>
					)}
					<button
						type="button"
						disabled={busy || text === undefined}
						onClick={() => (draft ? void save() : setDraft({ text: text!, base: text!, from: agent.notes }))}
						className={`${button} ${draft ? "bg-accent text-bg" : "border border-line hover:border-muted"}`}
					>
						{draft ? "Save" : "Edit"}
					</button>
				</div>
				{failed && <p className="text-sm text-err">{failed}</p>}
				{draft && agent.notes !== draft.from && <p className="text-xs text-warn">{agent.name} wrote to it since you started; saving will be refused so nothing is lost.</p>}
				{draft ? (
					<textarea
						autoFocus
						value={draft.text}
						disabled={busy}
						onChange={(event) => setDraft({ ...draft, text: event.target.value })}
						className="min-h-[60dvh] w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-accent"
					/>
				) : text?.trim() ? (
					<Markdown text={text} />
				) : (
					text !== undefined && <p className="text-sm text-muted">Nothing remembered yet.</p>
				)}
				{agent.duties.length > 0 && (
					<section className="mt-4 flex flex-col gap-1 border-t border-line pt-3">
						<h2 className="font-medium">Duties</h2>
						{agent.duties.map((duty) => (
							<Duty key={duty.name} agent={agent.id} duty={duty} />
						))}
					</section>
				)}
			</div>
		</div>
	);
}

/** What a duty runs and how often, and who added it; its last run, exit and wake (opening the thread it woke); and its next run. */
function Duty({ agent, duty }: { agent: string; duty: DutyInfo }) {
	const now = useNow();
	const supervisor = useStore((s) => s.snapshot?.agents.find((a) => a.role === "supervisor")?.name ?? "the supervisor");
	const woke = useStore((s) => s.snapshot?.threads.findLast((t) => t.agent === agent && t.title === `duty: ${duty.name}`));
	const when = (ts: number, t = ago(ts, now)) => (t === "now" ? "just now" : /\d[mh]$/.test(t) ? `${t} ago` : `on ${t}`);
	const next = ahead(duty.next, now);
	return (
		<div className="flex flex-col py-1 text-sm">
			<span>
				<span className="font-medium">{duty.name}</span>{" "}
				<span className="text-xs text-muted">
					every {duty.every}
					{duty.added && `, added by ${supervisor}`}
				</span>
			</span>
			<span className="flex flex-wrap gap-x-2 text-xs text-muted">
				<span>{duty.lastRun === undefined ? "not run yet" : `ran ${when(duty.lastRun)}`}</span>
				{duty.lastExit !== undefined && (
					<span className={duty.lastExit ? "text-err" : "text-ok"}>{duty.lastExit ? `failed, exit ${duty.lastExit}` : "ok"}</span>
				)}
				{duty.lastWoke !== undefined && (
					<a href={woke && href(woke.id)} className={woke ? "underline-offset-2 hover:text-fg hover:underline" : undefined}>
						woke {when(duty.lastWoke)}
					</a>
				)}
				<span title={new Date(duty.next).toLocaleString()}>{next === "now" ? "due now" : `next ${next}`}</span>
			</span>
		</div>
	);
}
