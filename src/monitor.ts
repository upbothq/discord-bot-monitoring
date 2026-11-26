import { randomUUID } from "node:crypto";
import type { Client } from "discord.js";
import { version as discordJsVersion } from "discord.js";
import { EventTracer } from "./collectors/events.ts";
import { GuildIssueCollector } from "./collectors/guild-issues.ts";
import { RuntimeCollector } from "./collectors/runtime.ts";
import { detectRelease } from "./release.ts";
import { InteractionCollector } from "./collectors/interactions.ts";
import { RateLimitCollector } from "./collectors/rate-limits.ts";
import { ShardCollector } from "./collectors/shards.ts";
import { readyEventName, runtimeVersion, totalShardCount } from "./compat.ts";
import { setRemoteSampling } from "./sampling.ts";
import { enableLogging, logger } from "./logger.ts";
import { Tracing } from "./tracing.ts";
import { type SendResult, Transport } from "./transport.ts";
import type {
	ReleasePayload,
	RemoteConfig,
	ShardMonitorOptions,
	ShardStatus,
	TelemetryReport,
} from "./types.ts";
import { PACKAGE_VERSION } from "./utils/version.ts";

const DEFAULT_ENDPOINT = "https://dash.upbot.app/api/telemetry";
const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 120_000;
const MAX_BACKOFF_MS = 300_000;
/** A shard changing status is reported shortly after, without waiting for the next interval. */
const STATUS_CHANGE_DELAY_MS = 1_000;

/**
 * Sends one report per process at a regular interval: the status of every shard it owns, plus
 * interaction and REST metrics aggregated since the previous report.
 */
export class ShardMonitor {
	private readonly client: Client;
	private readonly transport: Transport | undefined;
	private readonly shards: ShardCollector;
	private readonly interactions: InteractionCollector | undefined;
	private readonly events: EventTracer | undefined;
	private readonly issues = new GuildIssueCollector();
	private readonly runtime: RuntimeCollector;
	private release: ReleasePayload | undefined;
	private readonly rateLimits: RateLimitCollector | undefined;
	private readonly tracing: Tracing;
	private readonly instanceId: string = randomUUID();
	private readonly readyEvent: "ready" | "clientReady";

	private interval: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private nextReportAt = 0;
	private failures = 0;
	private inFlight: Promise<SendResult | undefined> | undefined;

	private started = false;
	private shuttingDown = false;
	private destroyed = false;

	constructor({
		client,
		token = process.env.UPBOT_TOKEN,
		endpoint,
		interval = DEFAULT_INTERVAL_MS,
		debug = false,
		interactions = true,
		rateLimits = true,
		tracing = true,
		events = true,
		normalizeCustomId,
	}: ShardMonitorOptions) {
		if (debug) enableLogging();

		this.client = client;
		this.interval = clampInterval(interval);
		this.readyEvent = readyEventName(discordJsVersion);
		this.shards = new ShardCollector(client, () => this.reportSoon());
		// Always loaded: even without interaction spans, reports must stay out of the bot's traces
		this.tracing = new Tracing();
		this.interactions = interactions
			? new InteractionCollector(client, tracing ? this.tracing : undefined, normalizeCustomId)
			: undefined;
		// Events always run in their guild context, they are traced only with `tracing`
		this.events = events ? new EventTracer(client, tracing ? this.tracing : undefined) : undefined;
		this.runtime = new RuntimeCollector(client);
		this.rateLimits = rateLimits ? new RateLimitCollector(client) : undefined;

		if (this.interactions) this.interactions.issues = this.issues;
		if (this.rateLimits) this.rateLimits.issues = this.issues;

		if (!token) {
			logger.error("BotMonitor: no token, pass `token` or set UPBOT_TOKEN, monitoring is disabled");
			this.transport = undefined;

			return;
		}

		const tracingRef = this.tracing;
		this.transport = new Transport(resolveEndpoint(endpoint), token, undefined, (fn) =>
			tracingRef.untraced(fn),
		);

		if (this.client.isReady()) {
			this.start();

			return;
		}

		this.client.once(this.readyEvent, this.handleReady);
	}

	/** Starts reporting. Called automatically once the client is ready. */
	start(): void {
		if (this.started || this.destroyed || !this.transport) return;

		this.started = true;

		logger.info(`Monitor started for ${this.client.user?.tag ?? "unknown client"}`);

		this.shards.register();
		// Before interactions: the event tracer dispatches listeners itself only over the plain emit
		this.events?.register();
		this.interactions?.register();
		this.rateLimits?.register();
		process.once("SIGTERM", this.handleSignal);
		process.once("SIGINT", this.handleSignal);

		// The first report waits for OpenTelemetry, otherwise it would be traced, and for the
		// fingerprint of the code, which tells a deployment from a restart
		void Promise.all([
			this.tracing.load(),
			detectRelease().then((release) => {
				this.release = release;
			}),
		]).finally(() => {
			this.schedule(0);
		});
	}

	/** Stops the periodic reports. Metrics keep being collected until `destroy()`. */
	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Reports every shard as offline, then stops monitoring. */
	async shutdown(): Promise<void> {
		if (this.shuttingDown || this.destroyed || !this.started) return;

		this.shuttingDown = true;
		this.stop();

		await this.inFlight;
		await this.send("offline");

		this.destroy();
	}

	/** Stops monitoring and removes everything the library added to the client and the process. */
	destroy(): void {
		if (this.destroyed) return;

		this.destroyed = true;
		this.stop();

		this.client.off(this.readyEvent, this.handleReady);
		this.shards.unregister();
		this.interactions?.unregister();
		this.events?.unregister();
		this.rateLimits?.unregister();

		process.off("SIGTERM", this.handleSignal);
		process.off("SIGINT", this.handleSignal);
	}

	private readonly handleReady = (): void => {
		this.start();
	};

	private schedule(delay: number): void {
		if (this.destroyed || this.shuttingDown) return;

		clearTimeout(this.timer);

		this.nextReportAt = Date.now() + delay;
		this.timer = setTimeout(() => void this.tick(), delay);
		this.timer.unref?.();
	}

	private reportSoon(): void {
		// While the API fails, the backoff decides when to try again
		if (!this.started || this.failures > 0) return;

		if (this.nextReportAt - Date.now() > STATUS_CHANGE_DELAY_MS) {
			this.schedule(STATUS_CHANGE_DELAY_MS);
		}
	}

	private async tick(): Promise<void> {
		const result = await this.send();

		if (!result || this.destroyed || this.shuttingDown) return;

		if (result.ok) {
			if (this.failures > 0) {
				logger.info("Reports are delivered again");
			}

			this.failures = 0;
			this.applyConfig(result.config);
			this.schedule(this.interval);

			return;
		}

		if (result.fatal) {
			logger.error(
				`BotMonitor: the token was refused (HTTP ${result.status}), monitoring is disabled`,
			);
			this.destroy();

			return;
		}

		this.failures++;

		// Rate limits are expected while a bot restarts many shards at once
		if (result.status === 429 || this.failures > 1) {
			logger.debug(`Report failed, retrying: ${result.reason}`);
		} else {
			logger.warn(`BotMonitor: report failed, retrying with backoff: ${result.reason}`);
		}

		this.schedule(
			result.retryAfterMs ?? Math.min(this.interval * 2 ** this.failures, MAX_BACKOFF_MS),
		);
	}

	/** Sends one report. Concurrent calls share the request in flight. */
	private send(forcedStatus?: ShardStatus): Promise<SendResult | undefined> {
		if (this.inFlight && !forcedStatus) {
			return this.inFlight;
		}

		const request = this.sendReport(forcedStatus).finally(() => {
			if (this.inFlight === request) {
				this.inFlight = undefined;
			}
		});

		this.inFlight = request;

		return request;
	}

	private async sendReport(forcedStatus?: ShardStatus): Promise<SendResult | undefined> {
		const transport = this.transport;

		if (!transport) return undefined;

		const interactions = this.interactions?.snapshot() ?? [];
		const api = this.rateLimits?.snapshot() ?? { rateLimits: [], invalidRequests: 0 };
		const guildIssues = this.issues.snapshot();
		const runtimeStats = forcedStatus ? undefined : this.runtime.snapshot();

		const report: TelemetryReport = {
			instance_id: this.instanceId,
			sdk_version: PACKAGE_VERSION,
			discordjs_version: discordJsVersion,
			runtime: runtimeVersion(),
			shard_count: totalShardCount(this.client),
			memory_usage: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100,
			uptime: this.client.uptime ?? 0,
			shards: this.shards.snapshot(forcedStatus),
			interactions,
			rate_limits: api.rateLimits,
			invalid_requests: api.invalidRequests,
			guild_issues: guildIssues,
			...(this.release ? { release: this.release } : {}),
			...(runtimeStats ? { runtime_stats: runtimeStats } : {}),
		};

		logger.debug(
			`Reporting ${report.shards.length} shard(s) and ${interactions.length} interaction name(s)`,
		);

		const result = await transport.send(report);

		if (!result.ok && !result.discard) {
			this.interactions?.restore(interactions);
			this.rateLimits?.restore(api);
			this.issues.restore(guildIssues);

			if (runtimeStats) this.runtime.retry();
		}

		if (!result.ok && result.discard && !result.fatal) {
			logger.error(`BotMonitor: report rejected: ${result.reason}`);
		}

		return result;
	}

	private applyConfig(config: RemoteConfig | undefined): void {
		if (!config) return;

		if (typeof config.interval_ms === "number") {
			this.interval = clampInterval(config.interval_ms);
		}

		if (this.interactions && typeof config.interactions === "boolean") {
			this.interactions.enabled = config.interactions;
		}

		if (this.rateLimits && typeof config.rate_limits === "boolean") {
			this.rateLimits.enabled = config.rate_limits;
		}

		// Read by the tracing SDK for every new trace, when startTracing() runs in this process
		if (config.traces && Number.isFinite(config.traces.sample_rate)) {
			setRemoteSampling({
				rate: Math.min(Math.max(config.traces.sample_rate as number, 0), 1),
				errorsOnly: config.traces.errors_only === true,
			});
		}
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
			logger.error("BotMonitor: failed to shutdown cleanly", error);
		}

		if (process.listenerCount(signal) === 0) {
			process.kill(process.pid, signal);
		}
	};
}

function clampInterval(interval: number): number {
	if (!Number.isFinite(interval)) return DEFAULT_INTERVAL_MS;

	return Math.min(Math.max(interval, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

function resolveEndpoint(endpoint: string | undefined): string {
	if (!endpoint) return DEFAULT_ENDPOINT;

	// 0.0.x reported each shard to /api/shards, the batched reports go to /api/telemetry
	return endpoint.replace(/\/api\/shards\/?$/u, "/api/telemetry");
}
