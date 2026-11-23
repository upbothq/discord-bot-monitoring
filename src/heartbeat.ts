import { type Client, Status } from "discord.js";
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
				// The manager status is global, a single dead shard would still report "online"
				const shardStatus = this.client.ws.shards.get(shardId)?.status ?? this.client.ws.status;
				const status = shardStatus === Status.Ready ? "online" : "offline";
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
