// The supervisor's read-only tools: pi-durable's file read, as `read_file` because `read` reads threads, and `fetch`.
import { defineTool } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";

const LIMIT = 200_000;

export const readFileTool = () => ({ ...createReadTool(), name: "read_file" });

export const fetchTool = defineTool({
	name: "fetch",
	description: `HTTP GET a URL. Returns the status and the body as text, cut at ${LIMIT / 1000} KB.`,
	parameters: Type.Object({ url: Type.String() }),
	replay: "safe",
	execute: async ({ url }, _api, context) => {
		const response = await fetch(url, { signal: context.abortSignal ?? null });
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			chunks.push(chunk);
			size += chunk.length;
			if (size > LIMIT) break;
		}
		const body = Buffer.concat(chunks).subarray(0, LIMIT).toString("utf8");
		const cut = size > LIMIT ? `\n[cut at ${LIMIT / 1000} KB]` : "";
		return { content: [{ type: "text", text: `HTTP ${response.status} ${response.statusText}\n\n${body}${cut}` }] };
	},
});
