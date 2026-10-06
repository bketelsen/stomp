// stomp server: `npm start` (or `node src/server/main.ts [--listen host:port]`). STOMP_LISTEN also overrides
// stomp.yaml's `listen`; STOMP_CONFIG and STOMP_STATE move the config and state directories.
import { parseArgs } from "node:util";
import { configDir, stateDir } from "./config.ts";
import { startStomp } from "./stomp.ts";

const { values } = parseArgs({ options: { listen: { type: "string" } } });
const listen = values.listen ?? process.env.STOMP_LISTEN;
const stomp = await startStomp({ configDir: configDir(), stateDir: stateDir(), ...(listen ? { listen } : {}) });

const state = await stomp.state();
const loggedIn = state.providers.filter((p) => p.loggedIn).map((p) => p.id);
const review = stomp.reviewers.length ? `review: ${stomp.reviewers.join(", ")}` : "review off (no review.pool in stomp.yaml)";
console.log(`stomp ${stomp.url}/ · ${state.agents.length} agents · logged in: ${loggedIn.join(", ") || "none"} · ${review} · judge: ${stomp.judge}`);

let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	await stomp.close();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
