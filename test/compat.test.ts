import { describe, expect, test } from "bun:test";
import { ownedShardIds, readyEventName, shardPing, socketStatus, totalShardCount } from "../src/compat.ts";
import { FakeClient } from "./helpers.ts";

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

		client.ws.shards = new Map([[1, { status: 0, ping: 10 }], [0, { status: 0, ping: 20 }]]);
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
});
