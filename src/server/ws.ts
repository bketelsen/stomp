// WebSocket /api/ws: `state` on connect and on change; per subscribed thread, the whole view (`base`) and then each
// commit's Chord ops from `conv.watch()`. A watch overflow arrives as a replace op and is forwarded like any other.
import type { Server } from "node:http";
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { type WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import type { Api } from "./http.ts";
import type { StateFeed } from "./state.ts";

type Stop = () => Promise<unknown> | void;

async function watchThread(api: Api, ws: WebSocket, thread: number, send: (msg: ServerMessage) => void): Promise<Stop> {
	try {
		const conversation = await api.thread(thread);
		const stop = new AbortController();
		const watch = await conversation.watch(withAbortSignal(stop.signal, ctx));
		send({ type: "base", thread, view: watch.value });
		watch.start(async (_value, ops) => send({ type: "ops", thread, ops: [...ops] }));
		return () => {
			stop.abort();
			return watch.stop();
		};
	} catch (error) {
		send({ type: "error", thread, message: (error as Error).message });
		return () => {};
	}
}

export function attachBridge(server: Server, api: Api, state: StateFeed): WebSocketServer {
	const wss = new WebSocketServer({ server, path: "/api/ws" });
	wss.on("connection", (ws) => {
		const send = (msg: ServerMessage) => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
		};
		const subscriptions = new Map<number, Promise<Stop>>();
		const unsubscribe = (thread: number) => {
			void subscriptions.get(thread)?.then((stop) => stop());
			subscriptions.delete(thread);
		};
		const unsubscribeState = state.subscribe((snapshot) => send({ type: "state", state: snapshot }));
		state.snapshot().then((snapshot) => send({ type: "state", state: snapshot }), console.error);
		ws.on("message", (raw) => {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(String(raw)) as ClientMessage;
			} catch {
				return send({ type: "error", message: "messages must be JSON" });
			}
			const thread = Number(msg.thread);
			unsubscribe(thread);
			// Subscribing again restarts the watch, so the next frame is always a fresh base.
			if (msg.type === "subscribe") subscriptions.set(thread, watchThread(api, ws, thread, send));
		});
		ws.on("close", () => {
			unsubscribeState();
			for (const thread of [...subscriptions.keys()]) unsubscribe(thread);
		});
	});
	return wss;
}
