// Fake Jev and Qwen servers on localhost: each request is answered by `reply` (a number is an HTTP status) and recorded.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** Whatever the judge sent. */
type Body = any;
export type Fake = { url: string; requests: { headers: IncomingHttpHeaders; body: Body }[]; close(): Promise<void> };

export async function fakeServer(reply: (body: Body) => unknown): Promise<Fake> {
	const requests: Fake["requests"] = [];
	const server = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		const body = JSON.parse(text) as Body;
		requests.push({ headers: req.headers, body });
		const answer = await reply(body);
		if (typeof answer === "number") res.writeHead(answer).end();
		else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
	};
}

const probabilities = ([a, b, c, d]: number[]) => ({ local_only: a, remote_read_only: b, remote_reversible: c, remote_irreversible: d });

/** Jev's answer to the two questions: local, read-only, reversible, irreversible, safe-first and (by default the same) risky-first. */
export const jevAnswer = (safe: number[], risky = safe) => ({
	answers: { effect_safe: { choice: "x", probabilities: probabilities(safe) }, effect_risky: { choice: "x", probabilities: probabilities(risky) } },
});

/** Qwen's single token, with logprobs for the digits 1–4. */
export const qwenAnswer = (p: number[]) => ({
	choices: [{ message: { content: "1" }, logprobs: { content: [{ top_logprobs: p.map((x, i) => ({ token: String(i + 1), logprob: Math.log(x) })) }] } }],
});
