import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ATTACHMENTS_MAX_BYTES, attach, parseAttachments } from "../src/server/attachments.ts";
import { startStomp } from "../src/server/stomp.ts";
import { agentFile, fixture, until } from "./support/fixture.ts";
import { scriptedModels } from "./support/scripted.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

test("attach: files saved under a new dir with plain, unique names, listed in the text; small images go inline", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "stomp-attach-"));
	t.after(() => rmSync(dir, { recursive: true }));
	assert.equal(attach(dir, "just text", []), "just text");
	const big = Buffer.alloc((5 << 20) + 1).toString("base64");
	const content = attach(dir, "look", [
		{ name: "../../etc/passwd", type: "text/plain", data: b64("not really") },
		{ name: "shot.png", type: "image/png", data: b64("png") },
		{ name: "shot.png", type: "image/png", data: big },
		{ name: ".env", type: "", data: b64("A=1") },
	], 42);
	const into = join(dir, "42");
	assert.deepEqual(content, [
		{ type: "text", text: `look\n\nAttached:\n- ${into}/passwd (text/plain, 10 B)\n- ${into}/shot.png (image/png, 3 B)\n- ${into}/shot-2.png (image/png, 5.0 MB)\n- ${into}/env (unknown type, 3 B)` },
		{ type: "image", data: b64("png"), mimeType: "image/png" },
	]);
	assert.equal(readFileSync(join(into, "passwd"), "utf8"), "not really");
	assert.equal(readFileSync(join(into, "env"), "utf8"), "A=1");
	assert.deepEqual(attach(dir, "", [{ name: "a.txt", type: "text/plain", data: b64("a") }], 43), [{ type: "text", text: `Attached:\n- ${join(dir, "43")}/a.txt (text/plain, 1 B)` }]);
	assert.throws(() => attach(dir, "", [{ name: "x", type: "", data: Buffer.alloc(ATTACHMENTS_MAX_BYTES + 1).toString("base64") }]), RangeError);
	assert.equal(typeof parseAttachments([{ name: "x", type: "", data: "not base64!" }]), "string");
	assert.equal(typeof parseAttachments("x"), "string");
	assert.deepEqual(parseAttachments(undefined), []);
});

test("a message with attachments: saved in the thread's dir, listed, the image inline; files alone need no text", async (t) => {
	const fx = fixture();
	fx.agent("alpha", agentFile("Alpha", "scripted/scripted-1"));
	const models = scriptedModels((r) => ({ text: `echo: ${r.lastUserText}` }));
	const stomp = await startStomp({ configDir: fx.configDir, stateDir: fx.stateDir, listen: "127.0.0.1:0", models });
	t.after(async () => {
		await stomp.close();
		fx.cleanup();
	});
	const desk = (await stomp.state()).agents[0]!.deskThread;
	const post = (body: unknown) => fx.fetch(`${stomp.url}/api/threads/${desk}/messages`, { method: "POST", body: JSON.stringify(body) });
	const attachments = [
		{ name: "notes.txt", type: "text/plain", data: b64("hello file") },
		{ name: "pic.png", type: "image/png", data: b64("png") },
	];
	assert.equal((await post({ text: "", attachments })).status, 200);
	assert.equal((await post({ text: "", attachments: [{ name: "x" }] })).status, 400);
	assert.equal((await post({ text: " " })).status, 400);
	const entries = async () => (await (await fx.fetch(`${stomp.url}/api/threads/${desk}/entries`)).json()) as { entries: { model?: { role: string; content: unknown }[] }[] };
	const user = await until(async () => (await entries()).entries.flatMap((e) => e.model ?? []).find((m) => m.role === "user"));
	const [text, image] = user.content as [{ text: string }, { type: string; mimeType: string }];
	const path = text.text.match(/^- (\S+notes\.txt) /m)![1]!;
	assert.ok(path.startsWith(join(fx.stateDir, "scratch", "attachments", String(desk))), path);
	assert.equal(readFileSync(path, "utf8"), "hello file");
	assert.deepEqual([image.type, image.mimeType], ["image", "image/png"]);
});
