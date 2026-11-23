import { ofetch } from "ofetch";
import type { Client } from "discord.js";
import { logger } from "./logger.ts";
import type { ShardPayload, ShardStatus } from "./types.ts";
import { PACKAGE_VERSION } from "./utils/version.ts";

/**
 * Responsible for building and sending shard status payloads to the API.
 * Single Responsibility: knows only how to report — nothing else.
 */
export class ShardReporter {
	constructor(
		private readonly client: Client,
		private readonly endpoint: string,
		private readonly token: string,
	) {}

	async report(shardId: number, status: ShardStatus): Promise<void> {
		logger.info(`Reporting shard ${shardId} as "${status}"`);

		try {
			await ofetch(this.endpoint, {
				method: "POST",
				body: this.buildPayload(shardId, status),
				headers: { Authorization: `Bearer ${this.token}`, 'x-upbot-package-version': PACKAGE_VERSION },
			});
		} catch (err) {
			const body = (err as { data?: unknown }).data;
			logger.error(`Failed to report shard ${shardId}:`, err, body !== undefined ? JSON.stringify(body) : "(no response body)");
		}
	}

	private buildPayload(shardId: number, status: ShardStatus): ShardPayload {
		return {
			shard_id: shardId,
			shard_count: this.client.shard?.count ?? 1,
			status,
			guild_count: this.client.guilds.cache.size,
			member_count: this.client.guilds.cache.reduce((sum, g) => sum + (g.memberCount ?? 0), 0),
			ping: this.client.ws.ping,
			memory_usage: process.memoryUsage().rss / 1024 / 1024,
			uptime: this.client.uptime ?? 0,
		};
	}
}
