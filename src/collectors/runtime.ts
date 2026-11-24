import type { Client } from "discord.js";
import type { RuntimeStatsPayload } from "../types.ts";

/** Walking every guild is not free on big bots: caches are measured about once a minute. */
const INTERVAL_MS = 60_000;

interface Cached {
	cache?: { size?: number };
}

function size(manager: unknown): number {
	const value = (manager as Cached | undefined)?.cache?.size;

	return typeof value === "number" ? value : 0;
}

function megabytes(bytes: number): number {
	return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

/**
 * Sizes of the discord.js caches and of the process memory, with the intents, sweepers and
 * listened events the dashboard needs to recommend a lighter cache setup.
 */
export class RuntimeCollector {
	private lastAt = 0;

	constructor(private readonly client: Client) {}

	/** The stats when a minute has passed since the last ones, undefined otherwise. */
	snapshot(now: number = Date.now()): RuntimeStatsPayload | undefined {
		if (now - this.lastAt < INTERVAL_MS) {
			return undefined;
		}

		this.lastAt = now;

		const client = this.client as unknown as {
			guilds?: Cached;
			channels?: Cached & { cache?: { values?: () => Iterable<unknown> } };
			users?: Cached;
			options?: { intents?: unknown; sweepers?: Record<string, unknown> };
			eventNames?: () => (string | symbol)[];
			listenerCount?: (event: string) => number;
		};

		const caches = {
			guilds: size(client.guilds),
			channels: size(client.channels),
			users: size(client.users),
			members: 0,
			presences: 0,
			voice_states: 0,
			roles: 0,
			emojis: 0,
			messages: 0,
		};

		const guilds =
			(
				client.guilds?.cache as { values?: () => Iterable<Record<string, unknown>> } | undefined
			)?.values?.() ?? [];

		for (const guild of guilds) {
			caches.members += size(guild.members);
			caches.presences += size(guild.presences);
			caches.voice_states += size(guild.voiceStates);
			caches.roles += size(guild.roles);
			caches.emojis += size(guild.emojis);
		}

		for (const channel of (client.channels?.cache?.values?.() ?? []) as Iterable<{
			messages?: Cached;
		}>) {
			caches.messages += size(channel.messages);
		}

		const memory = process.memoryUsage();
		const intents =
			(client.options?.intents as { bitfield?: unknown } | undefined)?.bitfield ??
			client.options?.intents;

		return {
			caches: caches as Record<string, number>,
			heap_used_mb: megabytes(memory.heapUsed),
			heap_total_mb: megabytes(memory.heapTotal),
			rss_mb: megabytes(memory.rss),
			external_mb: megabytes(memory.external),
			intents:
				typeof intents === "bigint" || typeof intents === "number" ? intents.toString() : null,
			sweepers: Object.keys(client.options?.sweepers ?? {}),
			listened_events: (client.eventNames?.() ?? []).filter(
				(event): event is string =>
					typeof event === "string" && (client.listenerCount?.(event) ?? 0) > 0,
			),
		};
	}

	/** Stats that could not be sent are measured again with the next report. */
	retry(): void {
		this.lastAt = 0;
	}
}
