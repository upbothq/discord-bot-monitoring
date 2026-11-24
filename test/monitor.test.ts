import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ShardMonitor } from "../src/monitor.ts";
import { chatInput, FakeClient, fakeDashboard, sleep, waitFor } from "./helpers.ts";

let monitors: ShardMonitor[] = [];
let dashboards: { stop: () => unknown }[] = [];

function shardedClient(): FakeClient {
	const client = new FakeClient();

	client.shard = { ids: [0, 1], count: 2 };
	client.ws.shards = new Map([
		[0, { status: 0, ping: 11 }],
		[1, { status: 5, ping: 22 }],
	]);
	client.guilds.cache.set("a", { shardId: 0, memberCount: 10 });
	client.guilds.cache.set("b", { shardId: 1, memberCount: 5 });
	client.guilds.cache.set("c", { shardId: 1, memberCount: 7 });

	return client;
}

function monitor(options: ConstructorParameters<typeof ShardMonitor>[0]): ShardMonitor {
	const instance = new ShardMonitor(options);
	monitors.push(instance);

	return instance;
}

function dashboard(...args: Parameters<typeof fakeDashboard>) {
	const instance = fakeDashboard(...args);
	dashboards.push(instance);

	return instance;
}

beforeEach(() => {
	delete process.env.UPBOT_TOKEN;
});

afterEach(() => {
	monitors.forEach((instance) => instance.destroy());
	dashboards.forEach((instance) => instance.stop());
	monitors = [];
	dashboards = [];
});

describe("ShardMonitor", () => {
	test("sends every shard of the process in one report", async () => {
		const api = dashboard();

		monitor({ client: shardedClient().asClient(), token: "secret", endpoint: api.url });
		await waitFor(() => api.requests.length === 1);

		const [request] = api.requests;

		expect(request?.headers.get("authorization")).toBe("Bearer secret");
		expect(request?.body).toMatchObject({
			shard_count: 2,
			shards: [
				{ shard_id: 0, status: "online", guild_count: 1, member_count: 10, ping: 11 },
				{ shard_id: 1, status: "offline", guild_count: 2, member_count: 12, ping: 22 },
			],
			interactions: [],
			rate_limits: [],
			invalid_requests: 0,
		});
	});

	test("reads the token from UPBOT_TOKEN", async () => {
		const api = dashboard();

		process.env.UPBOT_TOKEN = "from-env";
		monitor({ client: shardedClient().asClient(), endpoint: api.url });
		await waitFor(() => api.requests.length === 1);

		expect(api.requests[0]?.headers.get("authorization")).toBe("Bearer from-env");
	});

	test("does not start without a token", async () => {
		const api = dashboard();
		const error = spyOn(console, "error").mockImplementation(() => {});
		const client = shardedClient();

		monitor({ client: client.asClient(), endpoint: api.url });
		await sleep(50);

		expect(api.requests).toHaveLength(0);
		expect(error).toHaveBeenCalledTimes(1);
		expect(client.listenerCount("shardReady")).toBe(0);
		error.mockRestore();
	});

	test("waits for the ready event of the installed discord.js version", async () => {
		const api = dashboard();
		const client = shardedClient();

		client.ready = false;
		monitor({ client: client.asClient(), token: "secret", endpoint: api.url });
		await sleep(30);
		expect(api.requests).toHaveLength(0);

		client.ready = true;
		client.emit("clientReady");
		await waitFor(() => api.requests.length === 1);
	});

	test("sends interactions measured since the previous report", async () => {
		let reports = 0;
		const api = dashboard(() => {
			reports++;

			return Response.json({});
		});
		const client = shardedClient();

		client.on("interactionCreate", (interaction: { reply: () => Promise<void> }) => {
			void interaction.reply();
		});

		monitor({ client: client.asClient(), token: "secret", endpoint: api.url });
		await waitFor(() => reports === 1);

		client.emit("interactionCreate", chatInput("ping"));
		// A shard status change triggers the next report about a second later
		client.emit("shardDisconnect", {}, 1);
		await waitFor(() => reports === 2, 3_000);

		expect(api.requests[1]?.body.interactions).toMatchObject([
			{ type: "chat_input", name: "/ping", calls: 1 },
		]);
	});

	test("stops for good when the token is refused", async () => {
		const api = dashboard(() => new Response("Unauthorized", { status: 401 }));
		const error = spyOn(console, "error").mockImplementation(() => {});
		const client = shardedClient();
		const originalEmit = client.emit;

		monitor({ client: client.asClient(), token: "wrong", endpoint: api.url });
		await waitFor(() => error.mock.calls.length === 1);

		expect(api.requests).toHaveLength(1);
		expect(client.listenerCount("shardReady")).toBe(0);
		expect(client.emit).toBe(originalEmit);
		error.mockRestore();
	});

	test("stays quiet when rate limited", async () => {
		const api = dashboard(
			() => new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "30" } }),
		);
		const error = spyOn(console, "error").mockImplementation(() => {});
		const warn = spyOn(console, "warn").mockImplementation(() => {});

		monitor({ client: shardedClient().asClient(), token: "secret", endpoint: api.url });
		await waitFor(() => api.requests.length === 1);
		await sleep(20);

		expect(error).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		error.mockRestore();
		warn.mockRestore();
	});

	test("rewrites a 0.0.x endpoint to the telemetry endpoint", async () => {
		const api = dashboard();

		monitor({
			client: shardedClient().asClient(),
			token: "secret",
			endpoint: api.url.replace("/api/telemetry", "/api/shards"),
		});
		await waitFor(() => api.requests.length === 1);
	});

	test("shutdown reports every shard offline and leaves the process alone", async () => {
		const api = dashboard();
		const client = shardedClient();
		const sigterm = process.listenerCount("SIGTERM");
		const instance = monitor({ client: client.asClient(), token: "secret", endpoint: api.url });

		await waitFor(() => api.requests.length === 1);
		await instance.shutdown();

		expect(api.requests[1]?.body.shards).toMatchObject([
			{ status: "offline" },
			{ status: "offline" },
		]);
		expect(process.listenerCount("SIGTERM")).toBe(sigterm);
	});

	test("destroy removes every listener it added", async () => {
		const api = dashboard();
		const client = shardedClient();
		const sigterm = process.listenerCount("SIGTERM");
		const instance = monitor({ client: client.asClient(), token: "secret", endpoint: api.url });

		await waitFor(() => api.requests.length === 1);
		expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1);

		instance.destroy();

		expect(process.listenerCount("SIGTERM")).toBe(sigterm);
		expect(client.listenerCount("shardDisconnect")).toBe(0);
		expect(client.rest.listenerCount("rateLimited")).toBe(0);
	});
});
