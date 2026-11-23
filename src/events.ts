import type { Client } from "discord.js";
import { logger } from "./logger.ts";
import type { ShardReporter } from "./reporter.ts";

/**
 * Registers Discord.js shard lifecycle event listeners.
 * Observer pattern: reacts to shard events and delegates reporting.
 */
export class ShardEventListener {
	constructor(
		private readonly client: Client,
		private readonly reporter: ShardReporter,
	) {}

	register(): void {
		// Non-sharded bots: fire initial online report on ready
		if (!this.client.shard) {
			if (this.client.isReady()) {
				logger.debug("Shard 0 ready (non-sharded)");
				void this.reporter.report(0, "online");
			} else {
				this.client.once("ready", () => {
					logger.debug("Shard 0 ready (non-sharded)");
					void this.reporter.report(0, "online");
				});
			}
		}

		this.client.on("shardReady", (id) => {
			logger.debug(`Shard ${id} ready`);
			void this.reporter.report(id, "online");
		});

		this.client.on("shardResume", (id) => {
			logger.debug(`Shard ${id} resumed`);
			void this.reporter.report(id, "online");
		});

		this.client.on("shardReconnecting", (id) => {
			logger.debug(`Shard ${id} reconnecting`);
			void this.reporter.report(id, "reconnecting");
		});

		this.client.on("shardDisconnect", (_, id) => {
			logger.debug(`Shard ${id} disconnected`);
			void this.reporter.report(id, "offline");
		});

		this.client.on("shardError", (_, id) => {
			logger.debug(`Shard ${id} error`);
			void this.reporter.report(id, "error");
		});
	}
}
