import type { Client } from "discord.js";
import { fetchSocketStatuses, ownedShardIds, shardPing, socketStatus } from "../compat.ts";
import { logger } from "../logger.ts";
import type { ShardPayload, ShardStatus } from "../types.ts";
import { Listeners } from "./listeners.ts";

/**
 * Follows the status of every shard owned by this process. The live socket status wins: read on
 * the spot on v14, fetched before each report on v15. Shard events cover the versions with neither.
 */
export class ShardCollector {
	private readonly lastEvent = new Map<number, ShardStatus>();
	private readonly listeners: Listeners;
	private readonly gatewayListeners: Listeners;
	private live: Map<number, ShardStatus> | undefined;

	constructor(
		private readonly client: Client,
		private readonly onStatusChange: () => void,
	) {
		this.listeners = new Listeners(client as never);
		// v15 emits no shard event on the client, its WebSocketManager does
		this.gatewayListeners = new Listeners((client as unknown as { ws?: unknown }).ws as never);
	}

	register(): void {
		this.listeners.on("shardReady", (id: number) => this.record(id, "online"));
		this.listeners.on("shardResume", (id: number) => this.record(id, "online"));
		this.listeners.on("shardReconnecting", (id: number) => this.record(id, "reconnecting"));
		this.listeners.on("shardDisconnect", (_event: unknown, id: number) =>
			this.record(id, "offline"),
		);
		this.listeners.on("shardError", (_error: unknown, id: number) => this.record(id, "error"));

		// Only a hint that a status changed: the report fetches the status itself
		if (
			typeof (this.client.ws as unknown as { fetchStatus?: unknown }).fetchStatus === "function"
		) {
			for (const event of ["ready", "resumed", "closed"]) {
				this.gatewayListeners.on(event, () => this.onStatusChange());
			}
		}
	}

	unregister(): void {
		this.listeners.removeAll();
		this.gatewayListeners.removeAll();
	}

	/** Reads the live status of the shards when this discord.js version only gives it asynchronously. */
	async refresh(): Promise<void> {
		this.live = await fetchSocketStatuses(this.client);
	}

	snapshot(forcedStatus?: ShardStatus): ShardPayload[] {
		const ids = ownedShardIds(this.client);
		const counts = new Map<number, { guilds: number; members: number }>(
			ids.map((id) => [id, { guilds: 0, members: 0 }]),
		);

		// One pass over the cache, a process can own many shards and many guilds
		for (const guild of this.client.guilds.cache.values()) {
			const count = counts.get(guild.shardId ?? 0);

			if (count) {
				count.guilds++;
				count.members += guild.memberCount ?? 0;
			}
		}

		return ids.map((id) => ({
			shard_id: id,
			status: forcedStatus ?? this.statusOf(id),
			guild_count: counts.get(id)?.guilds ?? 0,
			member_count: counts.get(id)?.members ?? 0,
			ping: shardPing(this.client, id),
		}));
	}

	private statusOf(id: number): ShardStatus {
		return (
			socketStatus(this.client, id) ??
			this.live?.get(id) ??
			this.lastEvent.get(id) ??
			(this.client.isReady() ? "online" : "offline")
		);
	}

	private record(id: number, status: ShardStatus): void {
		logger.debug(`Shard ${id} is ${status}`);

		const previous = this.lastEvent.get(id);
		this.lastEvent.set(id, status);

		if (previous !== status) {
			this.onStatusChange();
		}
	}
}
