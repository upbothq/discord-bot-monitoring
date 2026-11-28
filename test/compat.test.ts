import { describe, expect, test } from "bun:test";
import {
	fetchSocketStatuses,
	ownedShardIds,
	readyEventName,
	shardPing,
	socketStatus,
	totalShardCount,
} from "../src/compat.ts";
import { FakeClient, FakeV15Client } from "./helpers.ts";

describe("discord.js compatibility", () => {
	test("picks the ready event of each version", () => {
		expect(readyEventName("14.0.3")).toBe("ready");
		expect(readyEventName("14.21.0")).toBe("ready");
		expect(readyEventName("14.22.0")).toBe("clientReady");
		expect(readyEventName("15.0.0-dev.1")).toBe("clientReady");
	});

	test("uses the ShardingManager shards first", () => {
		const client = new FakeClient();

		client.shard = { ids: [4, 5], count: 8 };

		expect(ownedShardIds(client.asClient())).toEqual([4, 5]);
		expect(totalShardCount(client.asClient())).toBe(8);
	});

	test("falls back to internal sharding, then to shard 0", () => {
		const client = new FakeClient();

		client.ws.shards = new Map([
			[1, { status: 0, ping: 10 }],
			[0, { status: 0, ping: 20 }],
		]);
		client.options.shardCount = 2;

		expect(ownedShardIds(client.asClient())).toEqual([0, 1]);
		expect(totalShardCount(client.asClient())).toBe(2);

		client.ws.shards = undefined;
		client.options.shardCount = undefined;

		expect(ownedShardIds(client.asClient())).toEqual([0]);
		expect(totalShardCount(client.asClient())).toBe(1);
	});

	test("reads each socket status and ping when the version exposes them", () => {
		const client = new FakeClient();

		client.ws.shards = new Map([
			[0, { status: 0, ping: 12 }],
			[1, { status: 2, ping: 30 }],
			[2, { status: 5, ping: -1 }],
		]);

		expect(socketStatus(client.asClient(), 0)).toBe("online");
		expect(socketStatus(client.asClient(), 1)).toBe("reconnecting");
		expect(socketStatus(client.asClient(), 2)).toBe("offline");
		expect(shardPing(client.asClient(), 1)).toBe(30);
	});

	test("works without per shard sockets, like discord.js v15", () => {
		const client = new FakeClient();

		client.ws.shards = undefined;

		expect(socketStatus(client.asClient(), 0)).toBeUndefined();
		expect(shardPing(client.asClient(), 0)).toBe(40);
	});

	test("reads the shards of the discord.js v15 WebSocketManager", async () => {
		const client = new FakeV15Client();

		client.statuses = new Map([
			[1, 3],
			[0, 0],
			[2, 2],
		]);
		client.ws.options.shardCount = 4;
		client.pings.set(1, 25);
		client.pings.set(2, 35);

		expect(ownedShardIds(client.asClient())).toEqual([0, 1, 2]);
		expect(totalShardCount(client.asClient())).toBe(4);
		expect(shardPing(client.asClient(), 1)).toBe(25);
		// No latency yet for shard 0: the client average
		expect(shardPing(client.asClient(), 0)).toBe(30);
		expect(socketStatus(client.asClient(), 1)).toBeUndefined();
		expect(await fetchSocketStatuses(client.asClient())).toEqual(
			new Map([
				[1, "online"],
				[0, "offline"],
				[2, "reconnecting"],
			]),
		);
	});

	test("leaves the v14 sockets to the synchronous status", async () => {
		expect(await fetchSocketStatuses(new FakeClient().asClient())).toBeUndefined();
	});

	test("gives up on a v15 status that fails or takes too long", async () => {
		const client = new FakeV15Client();

		client.fetchStatus = () => Promise.reject(new Error("worker gone"));
		expect(await fetchSocketStatuses(client.asClient())).toBeUndefined();

		client.fetchStatus = () => new Promise(() => {});
		expect(await fetchSocketStatuses(client.asClient(), 20)).toBeUndefined();
	});

	test("knows no latency before a v15 client connects", () => {
		expect(shardPing(new FakeV15Client().asClient(), 0)).toBe(-1);
	});
});
