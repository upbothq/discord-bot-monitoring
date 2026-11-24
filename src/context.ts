import { AsyncLocalStorage } from "node:async_hooks";

/** What the bot is handling when it calls the Discord API: a command, a component or an event. */
export interface DiscordContext {
	guildId: string | null;
	/** Interaction kind (chat_input, button…) or "event". */
	type: string;
	/** Command path, normalized custom ID or event name. */
	name: string;
	/** Permissions of the bot in the channel, as a decimal bitfield, when Discord sent them. */
	appPermissions: string | null;
}

/**
 * Follows the listeners of each interaction and event through their async calls, so a failed
 * REST request can be attributed to the guild and the command that made it.
 */
export const discordContext: AsyncLocalStorage<DiscordContext> =
	new AsyncLocalStorage<DiscordContext>();

/** Bitfield of a discord.js PermissionsBitField (bigint) or a raw API string. */
export function permissionsBitfield(value: unknown): string | null {
	const bitfield = (value as { bitfield?: unknown } | null | undefined)?.bitfield ?? value;

	if (typeof bitfield === "bigint" || typeof bitfield === "number") {
		return bitfield.toString();
	}

	return typeof bitfield === "string" && /^\d+$/u.test(bitfield) ? bitfield : null;
}
