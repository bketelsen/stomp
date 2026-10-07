// The app's state as one plain module, read with useSyncExternalStore. One WebSocket carries live views; REST does
// everything else.
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { useSyncExternalStore } from "react";
import type {
	AskAnswer,
	ClientMessage,
	ConversationView,
	EntryPage,
	JudgeDecision,
	SendMode,
	ServerMessage,
	StateSnapshot,
	ThreadInfo,
} from "../shared/protocol.ts";
import { titleOf } from "./view.ts";

export type Store = {
	snapshot?: StateSnapshot;
	connected: boolean;
	/** The open thread. */
	thread?: number;
	view?: ConversationView;
	/** History older than the view, oldest first. */
	older: EntryRecord[];
	/** The view's lowest entry id when `older` was fetched; a compaction moves it, and `older` is dropped. */
	olderFrom?: number;
	olderDone: boolean;
	error?: string;
	/** Threads that finished work since Brian last opened them. */
	unread: readonly number[];
	/** Agents Brian folded in the rail; this browser's preference. */
	collapsed: readonly string[];
};

const PAGE = 50;
/**
 * Unread, derived here: a thread that isn't open goes unread when it turns idle after being busy (working, reviewing,
 * needing Brian, or its delegation running), as does the thread a delegation reported to. What was busy and the newest
 * thread id persist, so work finished while the page was closed, a duty's thread included, still counts.
 */
type Seen = { busy: number[]; top: number; unread: number[] };
const SEEN = "stomp.seen";
let seen: Seen | undefined;
try {
	seen = JSON.parse(localStorage.getItem(SEEN) ?? "null") ?? undefined;
} catch {}
const keep = (next: Seen) => {
	seen = next;
	try {
		localStorage.setItem(SEEN, JSON.stringify(next));
	} catch {}
};
const busy = (t: ThreadInfo) => t.status !== "idle" || t.delegation === "running";
const COLLAPSED = "stomp.collapsed";
let collapsed: string[] = [];
try {
	collapsed = JSON.parse(localStorage.getItem(COLLAPSED) ?? "[]") ?? [];
} catch {}

let state: Store = { connected: false, older: [], olderDone: false, unread: seen?.unread ?? [], collapsed };
const listeners = new Set<() => void>();

function set(patch: Partial<Store>) {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export function useStore<T>(select: (store: Store) => T): T {
	return useSyncExternalStore(subscribe, () => select(state));
}

export const minId = (entries: readonly EntryRecord[]) => entries.reduce((min, entry) => Math.min(min, entry.id), Infinity);

let socket: WebSocket | undefined;

function send(message: ClientMessage) {
	if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export function connect() {
	const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`);
	socket = ws;
	ws.onopen = () => {
		set({ connected: true });
		if (state.thread !== undefined) send({ type: "subscribe", thread: state.thread });
	};
	ws.onmessage = (event) => receive(JSON.parse(String(event.data)) as ServerMessage);
	ws.onclose = () => {
		if (socket !== ws) return;
		socket = undefined;
		set({ connected: false });
		setTimeout(connect, 1000);
	};
}

/** Asks already notified. The first snapshot's are only noted, as is work finished while the page was closed: the page shows them. */
const asked = new Set<string>();
let primed = false;

/** With permission, unless Brian is looking at the thread. Clicking opens it. */
function notify(title: string, body: string, tag: string, thread: number) {
	if (!primed || typeof Notification === "undefined" || Notification.permission !== "granted") return;
	if (document.hasFocus() && state.thread === thread) return;
	try {
		const note = new Notification(title, { body, tag });
		note.onclick = () => {
			focus();
			location.hash = `#/thread/${thread}`;
			note.close();
		};
	} catch {} // Android Chrome notifies only from a service worker.
}

/** The tab title counts asks; a new ask and finished work notify. */
function onState(snapshot: StateSnapshot) {
	const asks = snapshot.asks ?? [];
	document.title = asks.length ? `(${asks.length}) stomp` : "stomp";
	const nameOf = (agent: string) => snapshot.agents.find((a) => a.id === agent)?.name ?? agent;
	for (const ask of asks.filter((ask) => !asked.has(ask.id))) {
		asked.add(ask.id);
		notify(`${nameOf(ask.agent)} needs you`, ask.command, ask.id, ask.thread);
	}
	const prev = seen;
	const unread = new Set(state.unread);
	const finished = snapshot.threads.filter(
		(t) => prev && !busy(t) && (prev.busy.includes(t.id) || (t.id > prev.top && t.delegatedBy !== undefined)),
	);
	for (const t of finished) {
		if (t.id !== state.thread) unread.add(t.id);
		if (t.delegation === "reported" && t.delegatedBy !== undefined && t.delegatedBy !== state.thread) unread.add(t.delegatedBy);
		notify(`${nameOf(t.agent)} finished: ${titleOf(t)}`, "", `done:${t.id}`, t.id);
	}
	primed = true;
	keep({ busy: snapshot.threads.filter(busy).map((t) => t.id), top: Math.max(0, ...snapshot.threads.map((t) => t.id)), unread: [...unread] });
	return unread.size === state.unread.length ? {} : { unread: [...unread] };
}

function receive(message: ServerMessage) {
	if (message.type === "state") return set({ snapshot: message.state, ...onState(message.state) });
	if (message.type === "error") return set({ error: message.message });
	if (message.thread !== state.thread) return;
	if (message.type === "base") return setView(message.view);
	if (state.view === undefined) return;
	try {
		setView(applyImmutable(state.view, message.ops as Op[]));
	} catch (error) {
		// A batch that doesn't apply means we drifted: start over from a fresh base.
		console.error("ops", error);
		send({ type: "unsubscribe", thread: message.thread });
		send({ type: "subscribe", thread: message.thread });
	}
}

function setView(view: ConversationView) {
	const moved = state.older.length > 0 && minId(view.entries) !== state.olderFrom;
	set(moved ? { view, older: [], olderFrom: undefined, olderDone: false } : { view });
}

/** The unread list without `thread`, saved. */
function read(thread: number | undefined): readonly number[] {
	const unread = state.unread.filter((id) => id !== thread);
	if (seen && unread.length !== state.unread.length) keep({ ...seen, unread });
	return unread;
}

export function select(thread: number | undefined) {
	if (thread === state.thread) return;
	if (state.thread !== undefined) send({ type: "unsubscribe", thread: state.thread });
	set({ thread, view: undefined, older: [], olderFrom: undefined, olderDone: false, error: undefined, unread: read(thread) });
	if (thread !== undefined) send({ type: "subscribe", thread });
}

/** Fold or unfold an agent in the rail. */
export function toggleAgent(agent: string) {
	const next = state.collapsed.includes(agent) ? state.collapsed.filter((id) => id !== agent) : [...state.collapsed, agent];
	try {
		localStorage.setItem(COLLAPSED, JSON.stringify(next));
	} catch {}
	set({ collapsed: next });
}

export const clearError = () => set({ error: undefined });

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`/api${path}`, {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	const json = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(json.error ?? `${response.status} ${response.statusText}`);
	return json;
}

/** Runs a request; a failure shows in the error bar and returns undefined. */
async function attempt<T>(request: Promise<T>): Promise<T | undefined> {
	try {
		return await request;
	} catch (error) {
		set({ error: (error as Error).message });
		return undefined;
	}
}

export const sendMessage = async (thread: number, text: string, mode: SendMode) =>
	(await attempt(api("POST", `/threads/${thread}/messages`, { text, mode }))) !== undefined;

export const abort = (thread: number) => attempt(api("POST", `/threads/${thread}/abort`, {}));

/** Put a thread away, which also marks it read, or bring it back. */
export async function archive(thread: number, archived: boolean) {
	if (archived) set({ unread: read(thread) });
	await attempt(api("POST", `/threads/${thread}/archive`, { archived }));
}

export async function newThread(agent: string) {
	const created = await attempt(api<{ thread: number }>("POST", `/agents/${encodeURIComponent(agent)}/threads`, {}));
	if (created) location.hash = `#/thread/${created.thread}`;
}

export async function loadEarlier() {
	const { thread, view, older } = state;
	if (thread === undefined || view === undefined) return;
	const from = minId(view.entries);
	const before = Math.min(from, minId(older));
	const page = await attempt(api<{ entries: EntryPage }>("GET", `/threads/${thread}/entries?before=${before}&limit=${PAGE}`));
	if (page === undefined || state.thread !== thread || state.view === undefined || minId(state.view.entries) !== from) return;
	const known = new Set(state.older.map((entry) => entry.id));
	const fresh = page.entries.filter((entry) => entry.id < from && !known.has(entry.id)).reverse();
	set({ older: [...fresh, ...state.older], olderFrom: from, olderDone: page.entries.length < PAGE });
}

export const answerAsk = async (id: string, answer: AskAnswer) =>
	(await attempt(api("POST", `/asks/${encodeURIComponent(id)}`, answer))) !== undefined;

/** The judge's latest decisions, newest first. Throws, so the feed can say so quietly instead of in the error bar. */
export const judgeLog = async (limit: number) => (await api<{ decisions: JudgeDecision[] }>("GET", `/judge?limit=${limit}`)).decisions;

/** An agent's notebook. These throw, so the notebook page can say so in place. */
const notes = (agent: string) => `/agents/${encodeURIComponent(agent)}/notebook`;
export const notebook = async (agent: string) => (await api<{ text: string }>("GET", notes(agent))).text;
export const saveNotebook = (agent: string, text: string, base: string) => api("PUT", notes(agent), { text, base });
