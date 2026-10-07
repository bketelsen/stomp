import assert from "node:assert/strict";
import { test } from "node:test";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { WebSocket } from "ws";
import type { ConversationView, ServerMessage } from "../src/shared/protocol.ts";
import { startStomp } from "../src/server/stomp.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { scriptedModels } from "./support/scripted.ts";

test("bridge: state, base then ops, REST commands and entries paging", async (t) => {
	const fx = fixture();
	fx.agent("alpha", agentFile("Alpha", "scripted/scripted-1", "title: ' Errands '\n"));
	fx.agent("broken", agentFile("Broken", "nope"));
	const models = scriptedModels((r) => ({ text: `echo: ${r.lastUserText}`, delayMs: 200 }));
	const stomp = await startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models });
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(stomp.url + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};

	const received: ServerMessage[] = [];
	const ws = new WebSocket(`${stomp.url.replace("http", "ws")}/api/ws`);
	ws.on("message", (raw) => received.push(JSON.parse(String(raw)) as ServerMessage));
	const first = await until(() => received.find((m) => m.type === "state"));
	const desk = first.state.agents.find((a) => a.id === "alpha")!.deskThread;
	assert.match(first.state.agents.find((a) => a.id === "broken")!.error!, /unknown model alias/);
	assert.equal(first.state.agents.find((a) => a.id === "alpha")!.title, "Errands");

	ws.send(JSON.stringify({ type: "subscribe", thread: desk }));
	const base = await until(() => received.find((m) => m.type === "base"));
	const { status, body } = await call("POST", `/api/threads/${desk}/messages`, { text: "hello" });
	assert.equal(status, 200);
	assert.equal(typeof body.submission, "string");
	await until(() => received.some((m) => m.type === "state" && m.state.threads[0]!.status === "working"));
	await until(() => received.some((m) => m.type === "state" && m.state.agents[0]!.status === "idle" && m !== first));
	let view = base.view;
	await until(() => {
		for (const m of received.splice(0)) if (m.type === "ops") view = applyImmutable(view, m.ops as Op[]) as ConversationView;
		return JSON.stringify(view.entries.at(-1)?.model).includes("echo: hello");
	});
	ws.close();

	const newer = await call("GET", `/api/threads/${desk}/entries?limit=2`);
	const entries = newer.body.entries as { id: number }[];
	assert.equal(entries.length, 2);
	assert.ok(entries[0]!.id > entries[1]!.id, "newest first");
	const older = (await call("GET", `/api/threads/${desk}/entries?before=${entries[1]!.id}&limit=50`)).body.entries as { id: number }[];
	assert.ok(older.length > 0 && older.every((e) => e.id < entries[1]!.id));

	const side = await call("POST", "/api/agents/alpha/threads", { title: "Side quest" });
	assert.equal(typeof side.body.thread, "number");
	assert.deepEqual((await stomp.state()).threads.map((thread) => [thread.title, thread.desk]), [["Alpha", true], ["Side quest", false]]);
	assert.equal((await call("POST", "/api/agents/broken/threads", {})).status, 409);
	// Archiving is a flag on the thread: it survives in the state, comes off again, and a desk can't have it.
	const archived = async () => (await stomp.state()).threads.find((thread) => thread.id === side.body.thread)!.archived;
	assert.deepEqual(await call("POST", `/api/threads/${side.body.thread}/archive`, { archived: true }), { status: 200, body: {} });
	assert.equal(await archived(), true);
	await call("POST", `/api/threads/${side.body.thread}/archive`, { archived: false });
	assert.equal(await archived(), undefined);
	assert.deepEqual(await call("POST", `/api/threads/${desk}/archive`, { archived: true }), { status: 409, body: { error: "a desk can't be archived" } });
	assert.equal((await call("POST", "/api/threads/999/archive", { archived: true })).status, 404);
	assert.equal((await call("POST", `/api/threads/${side.body.thread}/archive`, { archived: "yes" })).status, 400);
	assert.equal((await call("POST", `/api/threads/${desk}/messages`, { text: " " })).status, 400);
	assert.equal((await call("GET", "/api/threads/999/entries")).status, 404);
	assert.deepEqual(await call("POST", `/api/threads/${desk}/abort`), { status: 200, body: {} });
	assert.match(await (await fetch(`${stomp.url}/some/spa/route`)).text(), /npm run build|<!doctype html>/i);
});
