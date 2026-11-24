import type { DiscordContext } from "../context.ts";
import type { GuildIssuePayload } from "../types.ts";

/** Distinct (guild, source, route, code) entries kept per report, the rest is dropped. */
const MAX_ISSUES = 500;

/**
 * Counts Discord API errors per guild and per command or event, e.g. a 50013 Missing Permissions
 * on POST /channels/:id/messages during /ticket, with the permissions the bot had there.
 */
export class GuildIssueCollector {
	private issues = new Map<string, GuildIssuePayload>();

	record(context: DiscordContext | undefined, route: string, code: string): void {
		if (!context?.guildId) {
			return;
		}

		const key = issueKey(context.guildId, context.type, context.name, route, code);
		let issue = this.issues.get(key);

		if (!issue) {
			if (this.issues.size >= MAX_ISSUES) {
				return;
			}

			issue = {
				guild_id: context.guildId,
				type: context.type,
				name: context.name,
				route,
				code,
				count: 0,
				app_permissions: context.appPermissions,
			};
			this.issues.set(key, issue);
		}

		issue.count++;
	}

	snapshot(): GuildIssuePayload[] {
		const list = [...this.issues.values()];
		this.issues = new Map();

		return list;
	}

	/** Puts back issues that could not be sent, they go out with the next report. */
	restore(list: GuildIssuePayload[]): void {
		for (const item of list) {
			const key = issueKey(item.guild_id, item.type, item.name, item.route, item.code);
			const existing = this.issues.get(key);

			if (existing) {
				existing.count += item.count;
			} else if (this.issues.size < MAX_ISSUES) {
				this.issues.set(key, { ...item });
			}
		}
	}
}

function issueKey(...parts: string[]): string {
	return parts.join(" ");
}
