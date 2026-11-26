export type ShardStatus = "online" | "offline" | "reconnecting" | "error";

export type InteractionKind =
	| "chat_input"
	| "user_context"
	| "message_context"
	| "primary_entry_point"
	| "autocomplete"
	| "button"
	| "select_menu"
	| "modal";

export interface ShardMonitorOptions {
	/** Discord.js client instance. */
	client: import("discord.js").Client;
	/** Monitor token from the Upbot dashboard. Defaults to the UPBOT_TOKEN environment variable. */
	token?: string;
	/** Full URL of the telemetry endpoint. Defaults to https://dash.upbot.app/api/telemetry */
	endpoint?: string;
	/** Report interval in milliseconds, the dashboard can override it. Defaults to 10 000. */
	interval?: number;
	/** Enable library debug logging. Defaults to false. */
	debug?: boolean;
	/** Measure interactions: calls, response time, errors and unanswered ones. Defaults to true. */
	interactions?: boolean;
	/** Count rate limits and invalid requests on the REST API. Defaults to true. */
	rateLimits?: boolean;
	/** Open an OpenTelemetry span per interaction when `@opentelemetry/api` is installed. Defaults to true. */
	tracing?: boolean;
	/**
	 * Follow the Discord events the bot listens to (messageCreate, guildMemberAdd…): their Discord
	 * API errors are reported per guild, and with `tracing` each one gets a span. Defaults to true.
	 */
	events?: boolean;
	/**
	 * Groups dynamic custom IDs of buttons, select menus and modals under one name.
	 * By default IDs, snowflakes and UUIDs are replaced with `*`, e.g. `ticket:close:*`.
	 */
	normalizeCustomId?: (customId: string) => string;
}

export interface ShardPayload {
	shard_id: number;
	status: ShardStatus;
	guild_count: number;
	member_count: number;
	ping: number;
}

export interface InteractionPayload {
	type: InteractionKind;
	name: string;
	calls: number;
	errors: number;
	unanswered: number;
	latency_sum_ms: number;
	/** Count of acknowledged interactions per latency bucket, see LATENCY_BUCKETS_MS. */
	latency_buckets: number[];
	/** Failed responses by Discord API error code, e.g. { "10062": 2 }. */
	error_codes: Record<string, number>;
}

export interface RateLimitPayload {
	route: string;
	method: string;
	scope: string;
	global: boolean;
	hits: number;
	max_retry_after_ms: number;
}

export interface GuildIssuePayload {
	guild_id: string;
	/** Interaction kind or "event". */
	type: string;
	name: string;
	/** REST route, e.g. "POST /channels/:id/messages", or "interaction response". */
	route: string;
	/** Discord error code (50013…), or the HTTP status when the body had none. */
	code: string;
	count: number;
	/** Permissions of the bot in the channel, as a decimal bitfield. */
	app_permissions: string | null;
}

/** Version of the bot's code, so the dashboard can compare deployments. */
export interface ReleasePayload {
	id: string;
	/** Where the id comes from: UPBOT_RELEASE, the git commit, or a hash of the source files. */
	source: "env" | "git" | "files";
}

/** Sizes of the discord.js caches and of the process memory, sent about once a minute. */
export interface RuntimeStatsPayload {
	caches: Record<string, number>;
	heap_used_mb: number;
	heap_total_mb: number;
	rss_mb: number;
	external_mb: number;
	/** Gateway intents bitfield, as a decimal string. */
	intents: string | null;
	/** Cache sweepers configured on the client, e.g. ["messages"]. */
	sweepers: string[];
	/** Client events the bot listens to. */
	listened_events: string[];
}

export interface TelemetryReport {
	instance_id: string;
	sdk_version: string;
	discordjs_version: string;
	runtime: string;
	shard_count: number;
	memory_usage: number;
	uptime: number;
	shards: ShardPayload[];
	interactions: InteractionPayload[];
	rate_limits: RateLimitPayload[];
	invalid_requests: number;
	guild_issues: GuildIssuePayload[];
	release?: ReleasePayload;
	runtime_stats?: RuntimeStatsPayload;
}

/** Settings the dashboard sends back with each report. */
export interface RemoteConfig {
	interval_ms?: number;
	interactions?: boolean;
	rate_limits?: boolean;
	traces?: {
		sample_rate?: number;
		errors_only?: boolean;
	};
}
