import type { Client } from "discord.js";
import { ownedShardIds, shardPing, socketStatus } from "../compat.ts";
import { logger } from "../logger.ts";
import type { ShardPayload, ShardStatus } from "../types.ts";
import { Listeners } from "./listeners.ts";

/**
 * Follows the status of every shard owned by this process. The live socket status wins when the
 * discord.js version exposes it, shard events cover the versions that do not.
 */
export class ShardCollector {
	private readonly lastEvent = new Map<number, ShardStatus>();
	private readonly listeners: Listeners;

	constructor(
		private readonly client: Client,
		private readonly onStatusChange: () => void,
	) {
		this.listeners = new Listeners(client as never);
	}

	register(): void {
		this.listeners.on("shardReady", (id: number) => this.record(id, "online"));
		this.listeners.on("shardResume", (id: number) => this.record(id, "online"));
		this.listeners.on("shardReconnecting", (id: number) => this.record(id, "reconnecting"));
		this.listeners.on("shardDisconnect", (_event: unknown, id: number) => this.record(id, "offline"));
		this.listeners.on("shardError", (_error: unknown, id: number) => this.record(id, "error"));
	}

	unregister(): void {
		this.listeners.removeAll();
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
		return socketStatus(this.client, id)
			?? this.lastEvent.get(id)
			?? (this.client.isReady() ? "online" : "offline");
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
