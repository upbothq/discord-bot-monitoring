import type { Client } from "discord.js";
import { discordContext } from "../context.ts";
import type { RateLimitPayload } from "../types.ts";
import type { GuildIssueCollector } from "./guild-issues.ts";
import { Listeners } from "./listeners.ts";

const MAX_ROUTES = 200;

interface RateLimitInfo {
	route?: string;
	method?: string;
	global?: boolean;
	scope?: string;
	retryAfter?: number;
	timeToReset?: number;
}

interface RequestInfo {
	method?: string;
	route?: string;
	path?: string;
}

interface ResponseInfo {
	clone?: () => { json: () => Promise<unknown> };
	status?: number;
	statusCode?: number;
	headers?:
		| { get?: (name: string) => string | null }
		| Record<string, string | string[] | undefined>;
}

/**
 * Counts rate limits per route and the invalid requests (401, 403 and non-shared 429) that
 * Cloudflare bans an IP for when they reach 10 000 in 10 minutes.
 */
export class RateLimitCollector {
	enabled = true;
	/** Receives the 403 responses made while handling a command or an event, per guild. */
	issues: GuildIssueCollector | undefined;

	private routes = new Map<string, RateLimitPayload>();
	private invalidRequests = 0;
	private readonly listeners: Listeners;

	constructor(client: Client) {
		this.listeners = new Listeners((client as unknown as { rest?: never }).rest);
	}

	register(): void {
		this.listeners.on("rateLimited", (info: RateLimitInfo) => this.recordRateLimit(info));
		this.listeners.on("response", (request: RequestInfo, response: ResponseInfo) => {
			this.recordIssue(request, response);
			this.recordResponse(response);
		});
	}

	unregister(): void {
		this.listeners.removeAll();
	}

	snapshot(): { rateLimits: RateLimitPayload[]; invalidRequests: number } {
		const snapshot = {
			rateLimits: [...this.routes.values()],
			invalidRequests: this.invalidRequests,
		};

		this.routes = new Map();
		this.invalidRequests = 0;

		return snapshot;
	}

	restore({
		rateLimits,
		invalidRequests,
	}: {
		rateLimits: RateLimitPayload[];
		invalidRequests: number;
	}): void {
		this.invalidRequests += invalidRequests;

		for (const item of rateLimits) {
			const target = this.entry(item.route, item.method, item.scope, item.global);

			target.hits += item.hits;
			target.max_retry_after_ms = Math.max(target.max_retry_after_ms, item.max_retry_after_ms);
		}
	}

	private recordRateLimit(info: RateLimitInfo): void {
		if (!this.enabled) {
			return;
		}

		const global = info.global === true;
		const entry = this.entry(
			global ? "global" : (info.route ?? "unknown"),
			(info.method ?? "unknown").toUpperCase(),
			info.scope ?? (global ? "global" : "user"),
			global,
		);
		const retryAfter = info.retryAfter ?? info.timeToReset ?? 0;

		entry.hits++;
		entry.max_retry_after_ms = Math.max(entry.max_retry_after_ms, Math.round(retryAfter));
	}

	private recordResponse(response: ResponseInfo): void {
		if (!this.enabled) {
			return;
		}

		const status = response.status ?? response.statusCode;

		if (status !== 401 && status !== 403 && status !== 429) {
			return;
		}

		// Shared rate limits (per resource, not per bot) do not count towards the ban
		if (status === 429 && header(response, "x-ratelimit-scope") === "shared") {
			return;
		}

		this.invalidRequests++;
	}

	/**
	 * A 403 is a missing permission or access in a guild: attribute it to the command or event
	 * that made the request. The body is read from a copy, the bot still gets the error as usual.
	 */
	private recordIssue(request: RequestInfo | undefined, response: ResponseInfo): void {
		const status = response.status ?? response.statusCode;
		const context = discordContext.getStore();

		if (status !== 403 || !this.issues || !context?.guildId) {
			return;
		}

		const route = `${(request?.method ?? "unknown").toUpperCase()} ${request?.route ?? request?.path ?? "unknown"}`;
		const issues = this.issues;
		const fallback = () => issues.record(context, route, "403");

		if (typeof response.clone !== "function") {
			fallback();

			return;
		}

		try {
			void response
				.clone()
				.json()
				.then((body) => {
					const code = (body as { code?: unknown } | null)?.code;

					issues.record(
						context,
						route,
						typeof code === "number" && code > 0 ? String(code) : "403",
					);
				}, fallback);
		} catch {
			fallback();
		}
	}

	private entry(route: string, method: string, scope: string, global: boolean): RateLimitPayload {
		let key = `${method} ${route} ${scope}`;

		if (!this.routes.has(key) && this.routes.size >= MAX_ROUTES) {
			route = "(other)";
			key = `${method} ${route} ${scope}`;
		}

		let entry = this.routes.get(key);

		if (!entry) {
			entry = { route, method, scope, global, hits: 0, max_retry_after_ms: 0 };
			this.routes.set(key, entry);
		}

		return entry;
	}
}

function header(response: ResponseInfo, name: string): string | undefined {
	const headers = response.headers;

	if (!headers) {
		return undefined;
	}

	if (typeof headers.get === "function") {
		return headers.get(name) ?? undefined;
	}

	const value = (headers as Record<string, string | string[] | undefined>)[name];

	return Array.isArray(value) ? value[0] : value;
}
