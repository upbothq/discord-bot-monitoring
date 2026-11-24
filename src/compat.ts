import type { Client } from "discord.js";
import type { ShardStatus } from "./types.ts";

/**
 * Everything that differs between discord.js versions lives here, so the rest of the library
 * works the same on every v14 minor and on v15.
 */

/** Before 14.22 the client only emits "ready", 14.22+ and v15 emit "clientReady". */
export function readyEventName(version: string): "ready" | "clientReady" {
	const [major = 0, minor = 0] = version.split(".").map(Number);

	if (major > 14 || (major === 14 && minor >= 22)) {
		return "clientReady";
	}

	return "ready";
}

interface LegacyShard {
	status?: unknown;
	ping?: unknown;
}

interface LegacyShardCollection {
	get?: (id: number) => LegacyShard | undefined;
	keys?: () => Iterable<number>;
}

/** v14 keeps one WebSocketShard per shard on `client.ws.shards`, v15 does not. */
function legacyShards(client: Client): LegacyShardCollection | undefined {
	const shards = (client.ws as unknown as { shards?: LegacyShardCollection }).shards;

	return typeof shards?.get === "function" ? shards : undefined;
}

// Values of the discord.js v14 `Status` enum, inlined because not every version exports it
const SOCKET_READY = 0;
const SOCKET_IDLE = 3;
const SOCKET_DISCONNECTED = 5;

/** Live status of a shard socket, or undefined when this discord.js version does not expose it. */
export function socketStatus(client: Client, shardId: number): ShardStatus | undefined {
	const status = legacyShards(client)?.get?.(shardId)?.status;

	if (typeof status !== "number") {
		return undefined;
	}

	if (status === SOCKET_READY) {
		return "online";
	}

	if (status === SOCKET_IDLE || status === SOCKET_DISCONNECTED) {
		return "offline";
	}

	return "reconnecting";
}

/** Gateway latency of one shard, falling back to the client average, -1 when unknown. */
export function shardPing(client: Client, shardId: number): number {
	const ping = legacyShards(client)?.get?.(shardId)?.ping;

	if (typeof ping === "number" && Number.isFinite(ping)) {
		return Math.round(ping);
	}

	// The v14 average is NaN while no shard is connected
	const average = (client.ws as unknown as { ping?: unknown }).ping;

	return typeof average === "number" && Number.isFinite(average) ? Math.round(average) : -1;
}

/**
 * Shards owned by this process: from the ShardingManager when there is one, otherwise the
 * shards the client spawned itself (internal sharding), otherwise the single shard 0.
 */
export function ownedShardIds(client: Client): number[] {
	const managed = client.shard?.ids;

	if (managed && managed.length > 0) {
		return [...managed];
	}

	const internal = legacyShards(client)?.keys?.();
	const ids = internal ? [...internal] : [];

	return ids.length > 0 ? ids.sort((a, b) => a - b) : [0];
}

export function totalShardCount(client: Client): number {
	const managed = client.shard?.count;

	if (typeof managed === "number" && managed > 0) {
		return managed;
	}

	const configured = (client.options as { shardCount?: unknown }).shardCount;

	return typeof configured === "number" && configured > 0
		? configured
		: ownedShardIds(client).length;
}

export function runtimeVersion(): string {
	const versions = process.versions as NodeJS.ProcessVersions & { bun?: string; deno?: string };

	if (versions.bun) {
		return `bun ${versions.bun}`;
	}

	if (versions.deno) {
		return `deno ${versions.deno}`;
	}

	return `node ${versions.node}`;
}
