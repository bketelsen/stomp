// pi-ai CredentialStore in one JSON file keyed by provider id (file 0600, dir 0700). Writes re-read the file under a
// lock file and replace it atomically, so `npm run login` and the server can share it. Never log its contents.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

/** Stable per-installation UUID (not a secret). "Sign in with ChatGPT" requires one. */
export function deviceId(dir: string): string {
	ensureDir(dir);
	const file = join(dir, "device-id");
	try {
		const id = readFileSync(file, "utf8").trim();
		if (id) return id;
	} catch {}
	const id = randomUUID();
	writeFileSync(file, `${id}\n`, { mode: 0o600 });
	return id;
}

type Credentials = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
	readonly file: string;
	#chain: Promise<unknown> = Promise.resolve();

	constructor(file: string) {
		this.file = file;
		ensureDir(dirname(file));
	}

	async load(): Promise<Credentials> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
			return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Credentials) : {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`cannot read credential store ${this.file}: ${(error as Error).message}`);
		}
	}

	async #save(data: Credentials): Promise<void> {
		const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		const handle = await open(tmp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(data, null, "\t")}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, this.file);
	}

	/** Serialized in-process, then an O_EXCL lock file across processes; a lock older than 60 s is stale. */
	#locked<T>(task: (data: Credentials) => Promise<T>, signal?: AbortSignal): Promise<T> {
		const lock = `${this.file}.lock`;
		const run = this.#chain
			.catch(() => {})
			.then(async () => {
				for (let attempt = 0; ; attempt++) {
					signal?.throwIfAborted();
					try {
						await (await open(lock, "wx", 0o600)).close();
						break;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
						if (age > 60_000) await rm(lock, { force: true });
						else await new Promise((r) => setTimeout(r, Math.min(25 * 2 ** Math.min(attempt, 5), 500)));
					}
				}
				try {
					return await task(await this.load());
				} finally {
					await rm(lock, { force: true });
				}
			});
		this.#chain = run.catch(() => {});
		return run;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const data = await this.load();
		return Object.hasOwn(data, providerId) ? data[providerId] : undefined;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(await this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#locked(async (data) => {
			const current = Object.hasOwn(data, providerId) ? data[providerId] : undefined;
			const next = await fn(current);
			options?.signal?.throwIfAborted();
			if (next === undefined) return current;
			data[providerId] = next;
			await this.#save(data);
			return next;
		}, options?.signal);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#locked(async (data) => {
			if (!Object.hasOwn(data, providerId)) return;
			delete data[providerId];
			await this.#save(data);
		}, options?.signal);
	}
}
