// REST per src/shared/protocol.ts, and the built web UI from dist/web with an SPA fallback.
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import type { AskAnswer, JudgeDecision, SendMessageBody, StateSnapshot } from "../shared/protocol.ts";
import { NOTEBOOK_MAX_BYTES } from "./notebook.ts";

export type Api = {
	state(): Promise<StateSnapshot>;
	/** A thread's conversation; throws a 404 for ids that aren't stomp threads, a 409 if its agent can't chat. */
	thread(id: number, chatting?: boolean): Promise<Conversation>;
	newThread(agent: string, title: string): Promise<number>;
	/** Stop everything working for a thread: its delegation, its review, its run. */
	stop(id: number): Promise<void>;
	/** Archive a thread or bring it back; a 404 for an unknown thread, a 409 for a desk. */
	archive(id: number, archived: boolean): Promise<void>;
	/** Brian's answer to an ask; throws a 404 for an unknown or expired id. */
	answer(id: string, answer: AskAnswer): void;
	/** The judge's latest decisions, newest first. */
	decisions(limit: number): JudgeDecision[];
	/** An agent's notebook, after replacing it with `text` if given; throws a 404 for an unknown agent. */
	notebook(agent: string, text?: string): string;
};

const DECISIONS = ["allow", "always", "deny"];

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".webmanifest": "application/manifest+json",
	".map": "application/json",
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of req) text += chunk;
	try {
		const body = text ? (JSON.parse(text) as unknown) : {};
		if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
	} catch {}
	throw new HttpError(400, "body must be a JSON object");
}

async function route(api: Api, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const [, collection, id, action, extra] = url.pathname.split("/").filter(Boolean);
	const method = req.method ?? "GET";
	if (collection === "state" && id === undefined && method === "GET") return json(res, 200, await api.state());
	if (collection === "agents" && action === "threads" && extra === undefined && method === "POST") {
		const { title } = await readBody(req);
		const name = typeof title === "string" && title.trim() ? title.trim() : "New thread";
		return json(res, 200, { thread: await api.newThread(decodeURIComponent(id!), name) });
	}
	if (collection === "agents" && action === "notebook" && extra === undefined && (method === "GET" || method === "PUT")) {
		if (method === "GET") return json(res, 200, { text: api.notebook(decodeURIComponent(id!)) });
		const { text, base } = await readBody(req);
		if (typeof text !== "string") throw new HttpError(400, "text is required");
		if (Buffer.byteLength(text) > NOTEBOOK_MAX_BYTES) throw new HttpError(413, `a notebook holds at most ${NOTEBOOK_MAX_BYTES / 1024} KB`);
		// Saved only over the text the edit started from, so an agent's note added meanwhile isn't erased.
		if (typeof base === "string" && api.notebook(decodeURIComponent(id!)) !== base) {
			throw new HttpError(409, "the notebook changed while you were editing");
		}
		api.notebook(decodeURIComponent(id!), text);
		return json(res, 200, {});
	}
	if (collection === "asks" && id !== undefined && action === undefined && method === "POST") {
		const { decision, note } = await readBody(req);
		if (!DECISIONS.includes(decision as string)) throw new HttpError(400, `decision must be one of ${DECISIONS.join(", ")}`);
		const answer = { decision, ...(typeof note === "string" ? { note } : {}) } as AskAnswer;
		api.answer(decodeURIComponent(id), answer);
		return json(res, 200, {});
	}
	if (collection === "judge" && id === undefined && method === "GET") {
		const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
		return json(res, 200, { decisions: api.decisions(limit) });
	}
	if (collection !== "threads" || id === undefined || extra !== undefined) throw new HttpError(404, "not found");
	if (action === "messages" && method === "POST") {
		const body = (await readBody(req)) as Partial<SendMessageBody>;
		if (typeof body.text !== "string" || body.text.trim() === "") throw new HttpError(400, "text is required");
		const conversation = await api.thread(Number(id), true);
		const whenBusy = body.mode === "steer" ? "steer" : "followUp";
		const submission = await conversation.submit({ type: "input", content: body.text, whenBusy }, ctx);
		return json(res, 200, { submission: String(submission.id) });
	}
	if (action === "archive" && method === "POST") {
		const { archived } = await readBody(req);
		if (typeof archived !== "boolean") throw new HttpError(400, "archived must be true or false");
		await api.archive(Number(id), archived);
		return json(res, 200, {});
	}
	if (action === "abort" && method === "POST") {
		await api.stop(Number(id));
		return json(res, 200, {});
	}
	if (action === "entries" && method === "GET") {
		const conversation = await api.thread(Number(id));
		const before = Number(url.searchParams.get("before") ?? 0);
		const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
		const query = before > 0 ? { maxEntryId: (before - 1) as EntryId } : {};
		const page = await conversation.entries(query, limit, undefined, ctx);
		return json(res, 200, { entries: page.items });
	}
	throw new HttpError(404, "not found");
}

function serveStatic(webDir: string, url: URL, res: ServerResponse): void {
	const index = join(webDir, "index.html");
	if (!existsSync(index)) {
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("No web UI built yet: run `npm run build`.\n");
		return;
	}
	let file = normalize(join(webDir, decodeURIComponent(url.pathname)));
	if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) file = index;
	res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
}

/** Shown in the browser when the token is missing or wrong; a WebSocket close reason holds at most 123 bytes. */
export const UNAUTHORIZED = "stomp needs its token: open it with deploy/vm.sh open (see the README)";

/**
 * The API is for Brian's browser, which sends stomp's token as a bearer header, or as `?token=` on the WebSocket, which
 * can't set headers. Agents' shells run as stomp's user and reach its port; the token sits in $STOMP_STATE with stomp's
 * other secrets, and the judge guards it as it guards them.
 */
export function authorized(req: IncomingMessage, token: string): boolean {
	const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? new URL(req.url ?? "/", "http://stomp").searchParams.get("token") ?? "");
	return given.length === Buffer.byteLength(token) && timingSafeEqual(given, Buffer.from(token));
}

export function httpHandler(api: Api, webDir: string, token: string) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		const url = new URL(req.url ?? "/", "http://stomp");
		const handled = !url.pathname.startsWith("/api/")
			? Promise.resolve().then(() => serveStatic(webDir, url, res))
			: authorized(req, token)
				? route(api, req, res, url)
				: Promise.reject(new HttpError(401, UNAUTHORIZED));
		handled.catch((error: Error) => {
			const status = error instanceof HttpError ? error.status : 500;
			if (status === 500) console.error("[stomp]", req.method, url.pathname, error);
			if (!res.headersSent) json(res, status, { error: error.message });
		});
	};
}
