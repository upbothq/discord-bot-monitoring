import type { Client } from "discord.js";
import { logger } from "./logger.ts";
import type { ShardReporter } from "./reporter.ts";

/**
 * Schedules a periodic heartbeat for each shard owned by this process.
 */
export class ShardHeartbeat {
	private readonly timers: ReturnType<typeof setInterval>[] = [];

	constructor(
		private readonly client: Client,
		private readonly reporter: ShardReporter,
		private readonly interval: number,
	) {}

	start(shardIds: readonly number[]): void {
		for (const shardId of shardIds) {
			const tick = () => {
				const status = this.client.ws.status === 0 ? "online" : "offline";
				void this.reporter.report(shardId, status);
			};

			tick(); // immediate first report
			this.timers.push(setInterval(tick, this.interval));
		}

		logger.debug(`Heartbeat started for shards [${shardIds.join(", ")}] every ${this.interval}ms`);
	}

	stop(): void {
		for (const timer of this.timers) {
			clearInterval(timer);
		}

		this.timers.length = 0;
		logger.debug("Heartbeat stopped");
	}
}
