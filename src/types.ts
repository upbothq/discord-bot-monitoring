export type ShardStatus = "online" | "offline" | "reconnecting" | "error";

export interface ShardMonitorOptions {
	/** Discord.js client instance (must be spawned via ShardingManager). */
	client: import("discord.js").Client;
	/** Full URL of the shard reporting endpoint. Defaults to https://dash.upbot.app/api/shards */
	endpoint?: string;
	/** Bearer token used to authenticate requests. */
	token: string;
	/** Heartbeat interval in milliseconds. Defaults to 10 000. */
	interval?: number;
	/** Enable library debug logging. Defaults to false. */
	debug?: boolean;
}

export interface ShardPayload {
	shard_id: number;
	shard_count: number;
	status: ShardStatus;
	guild_count: number;
	member_count: number;
	ping: number;
	memory_usage: number;
	uptime: number;
}
