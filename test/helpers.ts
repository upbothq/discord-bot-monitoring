import { EventEmitter } from "node:events";
import type { Client } from "discord.js";

export interface FakeShardSocket {
	status: number;
	ping: number;
}

/** The parts of a discord.js Client the library reads, with nothing else. */
export class FakeClient extends EventEmitter {
	ready = true;
	uptime = 1_000;
	user = { tag: "bot#0001" };
	options: { shardCount?: number } = {};
	shard: { ids: number[]; count: number } | null = null;
	rest = new EventEmitter();
	ws: { status: number; ping: number; shards?: Map<number, FakeShardSocket> } = { status: 0, ping: 40, shards: new Map() };
	guilds = { cache: new Map<string, { shardId: number; memberCount: number }>() };

	isReady(): boolean {
		return this.ready;
	}

	asClient(): Client {
		return this as unknown as Client;
	}
}

export interface FakeInteraction {
	[key: string]: unknown;
	replied: boolean;
	deferred: boolean;
}

export function chatInput(name: string, subcommand?: string): FakeInteraction {
	return {
		id: "1",
		type: 2,
		commandType: 1,
		commandName: name,
		guildId: "42",
		replied: false,
		deferred: false,
		options: {
			getSubcommandGroup: () => null,
			getSubcommand: () => subcommand ?? null,
		},
		reply(this: FakeInteraction) {
			this.replied = true;

			return Promise.resolve();
		},
		deferReply(this: FakeInteraction) {
			this.deferred = true;

			return Promise.resolve();
		},
		editReply() {
			return Promise.resolve();
		},
	};
}

export function button(customId: string): FakeInteraction {
	return {
		id: "2",
		type: 3,
		componentType: 2,
		customId,
		replied: false,
		deferred: false,
		update(this: FakeInteraction) {
			this.replied = true;

			return Promise.resolve();
		},
	};
}

export interface ReceivedRequest {
	headers: Headers;
	body: Record<string, unknown>;
}

/** A local HTTP server standing in for the dashboard. */
export function fakeDashboard(respond: (request: ReceivedRequest) => Response = () => Response.json({})) {
	const requests: ReceivedRequest[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const received = { headers: request.headers, body: (await request.json()) as Record<string, unknown> };

			requests.push(received);

			return respond(received);
		},
	});

	return {
		requests,
		url: `http://127.0.0.1:${server.port}/api/telemetry`,
		stop: () => server.stop(true),
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();

	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}

		await sleep(10);
	}
}
