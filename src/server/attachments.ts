// Files Brian attaches to a message: each is saved under the thread's attachments dir, which agents read without asks,
// and the message lists their paths. Images also go to the model as image content, so a vision model sees them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Attachment } from "../shared/protocol.ts";

/** Raw bytes per message, all files together; the JSON body carries them as base64. */
export const ATTACHMENTS_MAX_BYTES = 20 << 20;
/** The largest image sent to the model inline; a bigger one is only saved. Providers cap images near 5 MB. */
const IMAGE_MAX_BYTES = 5 << 20;
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

/** Valid attachments from a request body, or a reason they aren't. */
export function parseAttachments(value: unknown): Attachment[] | string {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return "attachments must be a list";
	const ok = value.every((a: Partial<Attachment>) => typeof a?.name === "string" && a.name.trim() !== "" && typeof a.type === "string" && typeof a.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(a.data));
	return ok ? (value as Attachment[]) : "each attachment needs a name, a type and base64 data";
}

/** A plain file name: no directories, no leading dot, nothing a shell would trip on. */
const safe = (name: string) => name.split(/[\\/]/).pop()!.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "file";

/** Saves the files in a new dir under `dir` and returns the message content: the text with their paths, then images. */
export function attach(dir: string, text: string, files: Attachment[], now = Date.now()): string | (TextContent | ImageContent)[] {
	if (files.length === 0) return text;
	const bytes = files.map((file) => Buffer.from(file.data, "base64"));
	const total = bytes.reduce((sum, b) => sum + b.length, 0);
	if (total > ATTACHMENTS_MAX_BYTES) throw new RangeError(`attachments hold at most ${size(ATTACHMENTS_MAX_BYTES)}; these are ${size(total)}`);
	const into = join(dir, String(now));
	mkdirSync(into, { recursive: true, mode: 0o700 });
	const used = new Set<string>();
	const lines = files.map((file, i) => {
		let name = safe(file.name);
		for (let n = 2; used.has(name); n++) name = safe(file.name).replace(/(\.[^.]*)?$/, `-${n}$1`);
		used.add(name);
		writeFileSync(join(into, name), bytes[i]!, { mode: 0o600 });
		return `- ${join(into, name)} (${file.type || "unknown type"}, ${size(bytes[i]!.length)})`;
	});
	const images = files.flatMap((file, i): ImageContent[] => (IMAGES.has(file.type) && bytes[i]!.length <= IMAGE_MAX_BYTES ? [{ type: "image", data: file.data, mimeType: file.type }] : []));
	return [{ type: "text", text: `${text}${text ? "\n\n" : ""}Attached:\n${lines.join("\n")}` }, ...images];
}
