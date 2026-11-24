import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventTracer } from "../src/collectors/events.ts";
import { GuildIssueCollector } from "../src/collectors/guild-issues.ts";
import { InteractionCollector } from "../src/collectors/interactions.ts";
import { RateLimitCollector } from "../src/collectors/rate-limits.ts";
import { RuntimeCollector } from "../src/collectors/runtime.ts";
import { detectRelease, gitCommit, sourceHash } from "../src/release.ts";
import { chatInput, FakeClient, sleep } from "./helpers.ts";

const directories: string[] = [];

afterEach(async () => {
	delete process.env.UPBOT_RELEASE;
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function project(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "upbot-release-"));
	directories.push(directory);

	return directory;
}

/** A 403 as @discordjs/rest emits it, with the Discord error in the body. */
function forbidden(code: number) {
	return {
		status: 403,
		clone: () => ({ json: () => Promise.resolve({ code, message: "Missing Permissions" }) }),
	};
}

function setup() {
	const client = new FakeClient();
	const issues = new GuildIssueCollector();
	const interactions = new InteractionCollector(client.asClient(), undefined);
	const rest = new RateLimitCollector(client.asClient());
	const events = new EventTracer(client.asClient(), undefined);

	interactions.issues = issues;
	rest.issues = issues;
	events.register();
	interactions.register();
	rest.register();

	return { client, issues };
}

test("a 403 made while handling a command is reported for its guild, with the bot's permissions", async () => {
	const { client, issues } = setup();

	client.on("interactionCreate", async (interaction: { reply: () => Promise<void> }) => {
		await sleep(1);
		// What @discordjs/rest emits when the bot adds a role it may not manage
		client.rest.emit(
			"response",
			{ method: "put", route: "/guilds/:id/members/:id/roles/:id" },
			forbidden(50013),
		);
		await interaction.reply();
	});

	client.emit("interactionCreate", {
		...chatInput("ticket", "create"),
		appPermissions: { bitfield: 2048n },
	});
	await sleep(20);

	expect(issues.snapshot()).toEqual([
		{
			guild_id: "42",
			type: "chat_input",
			name: "/ticket create",
			route: "PUT /guilds/:id/members/:id/roles/:id",
			code: "50013",
			count: 1,
			app_permissions: "2048",
		},
	]);
});

test("errors of event listeners are reported too, requests outside any guild context are not", async () => {
	const { client, issues } = setup();

	client.on("guildMemberAdd", async () => {
		await sleep(1);
		client.rest.emit(
			"response",
			{ method: "PUT", route: "/guilds/:id/members/:id/roles/:id" },
			{ status: 403 },
		);
	});

	client.emit("guildMemberAdd", { guild: { id: "7" } });
	client.rest.emit("response", { method: "GET", route: "/gateway/bot" }, forbidden(50001));
	await sleep(20);

	expect(issues.snapshot()).toMatchObject([
		{ guild_id: "7", type: "event", name: "guildMemberAdd", code: "403" },
	]);
});

test("a failed response to an interaction is reported with its Discord code", async () => {
	const { client, issues } = setup();
	const interaction = chatInput("ping");

	interaction.reply = () =>
		Promise.reject(Object.assign(new Error("Unknown interaction"), { code: 10062 }));
	client.on("interactionCreate", (received: { reply: () => Promise<void> }) => {
		received.reply().catch(() => {});
	});

	client.emit("interactionCreate", interaction);
	await sleep(10);

	expect(issues.snapshot()).toMatchObject([
		{ guild_id: "42", name: "/ping", route: "interaction response", code: "10062" },
	]);
});

test("the release is UPBOT_RELEASE, then the git commit, then a hash of the source files", async () => {
	const directory = await project();

	await writeFile(join(directory, "index.js"), "console.log('v1')");
	await mkdir(join(directory, "node_modules", "lib"), { recursive: true });
	await writeFile(join(directory, "node_modules", "lib", "index.js"), "a");

	const first = await sourceHash(directory);

	// Dependencies do not change the fingerprint, the bot's code does
	await writeFile(join(directory, "node_modules", "lib", "index.js"), "b");
	expect(await sourceHash(directory)).toBe(first);
	await writeFile(join(directory, "index.js"), "console.log('v2')");
	expect(await sourceHash(directory)).not.toBe(first);
	expect(await detectRelease(directory)).toMatchObject({ source: "files" });

	const sha = "0123456789abcdef0123456789abcdef01234567";
	await mkdir(join(directory, ".git", "refs", "heads"), { recursive: true });
	await writeFile(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
	await writeFile(join(directory, ".git", "refs", "heads", "main"), `${sha}\n`);

	expect(await gitCommit(join(directory))).toBe(sha);
	expect(await detectRelease(directory)).toEqual({ id: "0123456789ab", source: "git" });

	process.env.UPBOT_RELEASE = "v2.4.0";
	expect(await detectRelease(directory)).toEqual({ id: "v2.4.0", source: "env" });
});

test("a commit only listed in packed-refs is found", async () => {
	const directory = await project();
	const sha = "fedcba9876543210fedcba9876543210fedcba98";

	await mkdir(join(directory, ".git"), { recursive: true });
	await writeFile(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
	await writeFile(join(directory, ".git", "packed-refs"), `# pack-refs\n${sha} refs/heads/main\n`);

	expect(await gitCommit(directory)).toBe(sha);
});

test("runtime stats count the caches about once a minute", () => {
	const client = new FakeClient();
	const guild = (members: number) => ({
		members: { cache: { size: members } },
		presences: { cache: { size: members * 2 } },
		roles: { cache: { size: 3 } },
	});

	Object.assign(client, {
		channels: { cache: new Map([["1", { messages: { cache: { size: 50 } } }]]) },
		guilds: {
			cache: new Map([
				["1", guild(10)],
				["2", guild(5)],
			]),
		},
		options: { intents: { bitfield: 33281 }, sweepers: { messages: {} } },
		users: { cache: { size: 12 } },
	});
	client.on("messageCreate", () => {});

	const runtime = new RuntimeCollector(client.asClient());
	const stats = runtime.snapshot(100_000);

	expect(stats?.caches).toMatchObject({
		guilds: 2,
		members: 15,
		presences: 30,
		roles: 6,
		messages: 50,
		users: 12,
	});
	expect(stats?.intents).toBe("33281");
	expect(stats?.sweepers).toEqual(["messages"]);
	expect(stats?.listened_events).toContain("messageCreate");
	expect(runtime.snapshot(130_000)).toBeUndefined();
	expect(runtime.snapshot(160_001)).toBeDefined();
});
