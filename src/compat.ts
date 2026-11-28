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

interface GatewayManager {
	getShardIds?: () => unknown;
	fetchStatus?: () => unknown;
	options?: { shardCount?: unknown };
}

/** v15 hands the gateway to the WebSocketManager of @discordjs/ws, which has no per shard sockets. */
function gatewayManager(client: Client): GatewayManager | undefined {
	return (client as unknown as { ws?: GatewayManager }).ws;
}

// Values of the @discordjs/ws `WebSocketShardStatus` enum used by v15, which differ from the v14 ones
const WS_IDLE = 0;
const WS_READY = 3;

/** A status request to the shard workers must not hold a report back. */
const FETCH_STATUS_TIMEOUT_MS = 1_000;

/**
 * Live status of every shard on discord.js v15, which only gives it asynchronously. Undefined when
 * this version exposes per shard sockets instead, or when the status cannot be read in time.
 */
export async function fetchSocketStatuses(
	client: Client,
	timeoutMs: number = FETCH_STATUS_TIMEOUT_MS,
): Promise<Map<number, ShardStatus> | undefined> {
	const manager = gatewayManager(client);

	if (legacyShards(client) || typeof manager?.fetchStatus !== "function") {
		return undefined;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		const statuses = await Promise.race([
			Promise.resolve(manager.fetchStatus()),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs);
				timer?.unref?.();
			}),
		]);

		if (!statuses || typeof (statuses as Map<unknown, unknown>).entries !== "function") {
			return undefined;
		}

		const result = new Map<number, ShardStatus>();

		for (const [id, status] of (statuses as Map<unknown, unknown>).entries()) {
			if (typeof id !== "number" || typeof status !== "number") continue;

			result.set(
				id,
				status === WS_READY ? "online" : status === WS_IDLE ? "offline" : "reconnecting",
			);
		}

		return result;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** Gateway latency of one shard, falling back to the client average, -1 when unknown. */
export function shardPing(client: Client, shardId: number): number {
	const ping =
		legacyShards(client)?.get?.(shardId)?.ping ??
		// v15 keeps the latency of each shard on the client
		(client as unknown as { pings?: { get?: (id: number) => unknown } }).pings?.get?.(shardId);

	if (typeof ping === "number" && Number.isFinite(ping)) {
		return Math.round(ping);
	}

	// The v14 average lives on the manager and is NaN while no shard is connected, the v15 one on
	// the client and is null
	const average =
		(client.ws as unknown as { ping?: unknown }).ping ??
		(client as unknown as { ping?: unknown }).ping;

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
	const ids = internal ? [...internal] : managerShardIds(client);

	return ids.length > 0 ? ids.sort((a, b) => a - b) : [0];
}

/** v15 shard ids, known once the client connected. */
function managerShardIds(client: Client): number[] {
	try {
		const ids = gatewayManager(client)?.getShardIds?.();

		return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === "number") : [];
	} catch {
		return [];
	}
}

export function totalShardCount(client: Client): number {
	const managed = client.shard?.count;

	if (typeof managed === "number" && managed > 0) {
		return managed;
	}

	// v14 keeps the count in the client options, v15 in the WebSocketManager ones
	const configured =
		(client.options as { shardCount?: unknown }).shardCount ??
		gatewayManager(client)?.options?.shardCount;

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
