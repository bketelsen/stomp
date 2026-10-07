// The wire contract between the stomp server and the web UI. Types, plus one shared pattern.
import type { ConversationView } from "@earendil-works/pi-durable";

export type { ConversationView };

/**
 * Working while its conversation has a run in flight; reviewing while a cross-family Review of its commits is live;
 * needs-you while one of its commands waits for Brian's answer (an ask). needs-you wins.
 */
export type ThreadStatus = "idle" | "working" | "reviewing" | "needs-you";

export interface AgentInfo {
	/** The agent file's name without `.md`. Stable; used in URLs. */
	id: string;
	/** The file's H1. */
	name: string;
	/** The file's `title`: a few words on what the agent is for, e.g. "NAS". */
	title?: string;
	/** The model alias as written in the file, e.g. "claude-sonnet". */
	model: string;
	/** What the alias resolved to. */
	provider: string;
	modelId: string;
	/** From the model id: anthropic, openai, google, qwen, xai, ... */
	family: string;
	/** Exactly one agent may have role "supervisor". */
	role: "agent" | "supervisor";
	/** The agent's long-lived desk thread. */
	deskThread: number;
	status: ThreadStatus;
	/** Set when the agent file failed to load; the agent is listed but can't be chatted with. */
	error?: string;
	/** Lines in the agent's notebook. */
	notes: number;
	/** The agent's scheduled duties and when they last ran. */
	duties: DutyInfo[];
}

export interface DutyInfo {
	name: string;
	/** As written in the agent file, e.g. "1h". */
	every: string;
	/** The supervisor added it, in duties.yaml. */
	added?: true;
	/** Epoch ms; absent until the first run. */
	lastRun?: number;
	/** The last check's exit code, and whether it woke the agent. */
	lastExit?: number;
	lastWoke?: number;
	/** Epoch ms of the next run. */
	next: number;
}

//   GET /api/agents/:agent/notebook          -> {text: string}
//   PUT /api/agents/:agent/notebook  {text, base?}  -> {}   409 if the notebook is no longer `base`

export interface ThreadInfo {
	id: number;
	agent: string;
	title: string;
	desk: boolean;
	/** Epoch ms. */
	createdAt: number;
	status: ThreadStatus;
	/** Set on threads the supervisor delegated: its thread id, and where the delegation stands. */
	delegatedBy?: number;
	delegation?: DelegationStatus;
	/** Set once the thread is bound to a worktree: the repo ("owner/name" or a local path) and its branch. */
	repo?: string;
	branch?: string;
	/** The latest finished cross-family review of this thread's commits. */
	review?: ReviewRecord;
	/** Brian archived it. Desks can't be. */
	archived?: true;
}

export interface ReviewFinding {
	severity: "blocking" | "note";
	file?: string;
	line?: number;
	summary: string;
}

/** A finished review. "failed" means the reviewer never gave a verdict; it blocks nothing. */
export interface ReviewRecord {
	/** The commit the last round reviewed. */
	sha: string;
	verdict: "approved" | "changes_requested" | "failed";
	findings: ReviewFinding[];
	/** provider/modelId and family of the reviewer. */
	reviewer: string;
	family: string;
	/** Review rounds run (fix rounds + 1). */
	rounds: number;
}

/** A review card in a thread's transcript: a no-turn entry of this kind whose data is a ReviewRecord. */
export const REVIEW_ENTRY = "stomp.review";

/** From the Delegation task, derived: running until the report is delivered, then reported. */
export type DelegationStatus = "running" | "reported" | "cancelled" | "failed";

/** Tokens since the store was created, summed over every thread. */
export interface ProviderUsage {
	provider: string;
	input: number;
	output: number;
}

/**
 * Wire shapes the UI recognizes in transcripts:
 * - a `delegate` tool result carries `details: DelegateDetails`;
 * - a report arrives in the supervisor's thread as user input starting with `[report from <name>, thread <id>]`.
 */
export interface DelegateDetails {
	agent: string;
	thread: number;
}
export const REPORT_PREFIX = /^\[report from (.+?), thread (\d+)\]\s*/;

export interface ProviderInfo {
	id: string;
	loggedIn: boolean;
}

export interface StateSnapshot {
	agents: AgentInfo[];
	threads: ThreadInfo[];
	providers: ProviderInfo[];
	usage: ProviderUsage[];
	/** Commands waiting for Brian, oldest first. In memory only: a restart re-asks them. */
	asks: Ask[];
}

/** A command the judge didn't clear. Its id is stable across restarts (task id and call id). */
export interface Ask {
	id: string;
	thread: number;
	agent: string;
	command: string;
	cwd: string;
	/** Why it's asking, with its source: "rule: gh pr merge **", "jev: remote_irreversible 0.82", "no judge: ...". */
	why: string;
	/** Epoch ms. */
	createdAt: number;
	/** No "always" for this one: approvals of stomp's own files are one at a time, so agents can't self-approve. */
	once?: true;
}

//   POST /api/asks/:id  AskAnswer  -> {}
//   GET  /api/judge?limit=<n>      -> {decisions: JudgeDecision[]}  newest first
export interface AskAnswer {
	/** "always" also allows commands like this one for this agent from now on. */
	decision: "allow" | "always" | "deny";
	/** For deny: goes back to the agent as the reason. */
	note?: string;
}

/** One line of the judge's log. */
export interface JudgeDecision {
	/** Epoch ms. */
	at: number;
	thread: number;
	agent: string;
	command: string;
	outcome: "run" | "ask";
	/** What decided it. */
	by: "allow-rule" | "ask-rule" | "jev" | "qwen" | "fallback";
	/** The rule, or the judge's read. */
	detail?: string;
	/** How long the judge took, for jev and qwen. */
	ms?: number;
	/** Brian's answer, for asks. */
	answer?: "allow" | "always" | "deny";
}

// REST (JSON bodies; errors are {error: string} with a 4xx/5xx status)
//   GET  /api/state                                  -> StateSnapshot
//   POST /api/agents/:agent/threads   {title?}       -> {thread: number}
//   POST /api/threads/:thread/messages {text, mode}  -> {submission: string}
//   POST /api/threads/:thread/abort                  -> {}
//   POST /api/threads/:thread/archive {archived}     -> {}   409 for a desk
//   GET  /api/threads/:thread/entries?before=<entryId>&limit=<n>  -> {entries: EntryPage}
export type SendMode = "followUp" | "steer";

export interface SendMessageBody {
	text: string;
	mode?: SendMode;
}

/** Older history, newest first, as returned by `conv.entries()`. */
export type EntryPage = ConversationView["entries"];

// WebSocket /api/ws
export type ClientMessage = { type: "subscribe"; thread: number } | { type: "unsubscribe"; thread: number };

export type ServerMessage =
	/** On connect, and whenever agents, threads, statuses or providers change. */
	| { type: "state"; state: StateSnapshot }
	/** First frame after each subscribe: the whole view. (A watch overflow arrives as an `ops` frame holding ["r", view].) */
	| { type: "base"; thread: number; view: ConversationView }
	/** Each commit's Chord ops; apply with `applyImmutable` from `@earendil-works/chord/delta`. */
	| { type: "ops"; thread: number; ops: unknown[] }
	| { type: "error"; thread?: number; message: string };
