// Trying something again in the background: after 1s, doubling with each failure to 5 minutes, back to 1s on success.
// MCP servers and OpenAI-compatible model servers both use it.

export type Backoff = {
	/** It failed: `attempt` again later, unless that's already set or the backoff is stopped. */
	failed(): void;
	/** It worked: the next failure waits 1s again. */
	ok(): void;
	/** An attempt is set. */
	readonly waiting: boolean;
	stop(): void;
};

export function backoff(attempt: () => void, firstMs = 1_000, capMs = 300_000): Backoff {
	let failures = 0;
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;
	return {
		failed() {
			if (stopped || timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				attempt();
			}, Math.min(firstMs * 2 ** failures++, capMs));
		},
		ok() {
			failures = 0;
			clearTimeout(timer);
			timer = undefined;
		},
		get waiting() {
			return timer !== undefined;
		},
		stop() {
			stopped = true;
			clearTimeout(timer);
		},
	};
}
