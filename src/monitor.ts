import type { Client } from "discord.js";
import { version as discordJsVersion } from "discord.js";
import { enableLogging, logger } from "./logger.ts";
import { ShardReporter } from "./reporter.ts";
import { ShardEventListener } from "./events.ts";
import { ShardHeartbeat } from "./heartbeat.ts";
import type { ShardMonitorOptions } from "./types.ts";

const DEFAULT_ENDPOINT = "https://dash.upbot.app/api/shards";

/**
 * discord.js:
 * - < 14.22.0: use "ready"
 * - >= 14.22.0: use "clientReady"
 * - >= 15.0.0: only "clientReady"
 */
function getReadyEventName(version: string): "ready" | "clientReady" {
	const [major = 0, minor = 0] = version.split(".").map(Number);

	if (major >= 15) {
		return "clientReady";
	}

	if (major === 14 && minor >= 22) {
		return "clientReady";
	}

	return "ready";
}

/**
 * Facade that wires together the reporter, event listener, and heartbeat.
 * Consumers only ever interact with this class.
 */
export class ShardMonitor {
	private readonly client: Client;
	private readonly reporter: ShardReporter;
	private readonly eventListener: ShardEventListener;
	private readonly heartbeat: ShardHeartbeat;

	private started = false;
	private shuttingDown = false;

	constructor({
		client,
		endpoint = DEFAULT_ENDPOINT,
		token,
		interval = 10_000,
		debug = false,
	}: ShardMonitorOptions) {
		if (debug) enableLogging();

		if (!token) {
			logger.error("ShardMonitor: token is required — monitor will not start");
		}

		this.client = client;
		this.reporter = new ShardReporter(client, endpoint, token);
		this.eventListener = new ShardEventListener(client, this.reporter);
		this.heartbeat = new ShardHeartbeat(client, this.reporter, interval);

		if (this.client.isReady()) {
			this.start();
			return;
		}

		const readyEvent = getReadyEventName(discordJsVersion);

		this.client.once(readyEvent, () => {
			this.start();
		});
	}

	/** Starts event listeners and heartbeat. Called automatically once the client is ready. */
	start(): void {
		if (this.started) return;

		this.started = true;

		const shardIds = this.client.shard?.ids ?? [0];

		logger.info(`Shard monitor started for ${this.client.user?.tag ?? "unknown client"}`);
		logger.info(`Starting monitor for shards [${shardIds.join(", ")}]`);

		this.eventListener.register();
		this.heartbeat.start(shardIds);

		process.once("SIGTERM", this.handleSignal);
		process.once("SIGINT", this.handleSignal);
	}

	/** Stops the heartbeat timers. Event listeners remain active. */
	stop(): void {
		this.heartbeat.stop();
	}

	/** Reports all shards as offline and stops the monitor. */
	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;

		this.shuttingDown = true;

		this.heartbeat.stop();

		const shardIds = this.client.shard?.ids ?? [0];

		await Promise.all(
			shardIds.map((id) => this.reporter.report(id, "offline")),
		);
	}

	/**
	 * Reports the shards offline without taking over the bot's own shutdown: when the bot listens
	 * to the signal, it decides when to exit. Otherwise the signal is raised again so the process
	 * ends as it would have without this library.
	 */
	private readonly handleSignal = async (signal: NodeJS.Signals): Promise<void> => {
		try {
			await this.shutdown();
		} catch (error) {
			logger.error("ShardMonitor: failed to shutdown cleanly", error);
		}

		if (process.listenerCount(signal) === 0) {
			process.kill(process.pid, signal);
		}
	};
}