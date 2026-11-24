import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ReleasePayload } from "./types.ts";

const SOURCE_EXTENSIONS = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json)$/u;
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	".git",
	".cache",
	".next",
	"coverage",
	".turbo",
	"logs",
	"tmp",
]);
const MAX_FILES = 5_000;
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Identifies the version of the bot's code, to tell a deployment from a plain restart:
 * UPBOT_RELEASE when set, else the git commit, else a hash of the source files, since most
 * bots have no release process and are just edited and restarted.
 */
export async function detectRelease(
	directory: string = process.cwd(),
): Promise<ReleasePayload | undefined> {
	const fromEnv = process.env.UPBOT_RELEASE?.trim();

	if (fromEnv) {
		return { id: fromEnv.slice(0, 100), source: "env" };
	}

	try {
		const commit = await gitCommit(directory);

		if (commit) {
			return { id: commit.slice(0, 12), source: "git" };
		}

		const hash = await sourceHash(directory);

		return hash ? { id: hash, source: "files" } : undefined;
	} catch {
		return undefined;
	}
}

/** Reads the commit of HEAD from the .git directory, without the git binary. */
export async function gitCommit(directory: string): Promise<string | undefined> {
	let current = resolve(directory);

	for (let depth = 0; depth < 6; depth++) {
		const gitDirectory = join(current, ".git");
		const head = await readFile(join(gitDirectory, "HEAD"), "utf8").catch(() => undefined);

		if (head !== undefined) {
			const ref = /^ref: (.+)$/mu.exec(head.trim())?.[1];

			if (!ref) {
				return /^[0-9a-f]{40}$/u.test(head.trim()) ? head.trim() : undefined;
			}

			const loose = await readFile(join(gitDirectory, ref), "utf8").catch(() => undefined);

			if (loose && /^[0-9a-f]{40}/u.test(loose.trim())) {
				return loose.trim();
			}

			const packed = await readFile(join(gitDirectory, "packed-refs"), "utf8").catch(() => "");

			return packed
				.split("\n")
				.find((line) => line.endsWith(` ${ref}`))
				?.slice(0, 40);
		}

		const parent = dirname(current);

		if (parent === current) {
			return undefined;
		}

		current = parent;
	}

	return undefined;
}

/** Hash of the path and content of the bot's source files, outside node_modules. */
export async function sourceHash(directory: string): Promise<string | undefined> {
	const root = resolve(directory);
	const files: string[] = [];
	const pending = [root];

	while (pending.length > 0 && files.length < MAX_FILES) {
		const current = pending.pop() as string;
		const entries = await readdir(current, { withFileTypes: true }).catch(() => []);

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
					pending.push(join(current, entry.name));
				}
			} else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
				files.push(join(current, entry.name));
			}
		}
	}

	if (files.length === 0) {
		return undefined;
	}

	const hash = createHash("sha1");

	for (const file of files.sort()) {
		const info = await stat(file).catch(() => undefined);

		if (!info || info.size > MAX_FILE_SIZE) {
			continue;
		}

		hash.update(relative(root, file));
		hash.update("\0");
		hash.update(await readFile(file).catch(() => ""));
		hash.update("\0");
	}

	return hash.digest("hex").slice(0, 12);
}
