/** BotMonitor is the same class: it monitors any bot, sharded or not. */
export { ShardMonitor, ShardMonitor as BotMonitor } from "./monitor.ts";
export { UNTRACED_EVENTS } from "./collectors/events.ts";
export { defaultNormalizeCustomId } from "./collectors/interactions.ts";
export { LATENCY_BUCKETS_MS } from "./collectors/histogram.ts";
export type {
	InteractionKind,
	InteractionPayload,
	RateLimitPayload,
	RemoteConfig,
	ShardMonitorOptions,
	ShardMonitorOptions as BotMonitorOptions,
	ShardPayload,
	ShardStatus,
	TelemetryReport,
} from "./types.ts";
