import type { RemoteConfig, TelemetryReport } from "./types.ts";
import { PACKAGE_VERSION } from "./utils/version.ts";

/** A slow API must never pile up pending requests or hold the process on shutdown. */
const REQUEST_TIMEOUT_MS = 5_000;

export type SendResult =
	| { ok: true; config: RemoteConfig | undefined }
	| {
			ok: false;
			/** The token is refused, retrying cannot succeed. */
			fatal: boolean;
			/** The report was rejected as is, its metrics must not be sent again. */
			discard: boolean;
			retryAfterMs: number | undefined;
			status: number | undefined;
			reason: string;
	  };

interface RawResponse {
	status: number;
	retryAfter: string | null;
	body: string;
}

export class Transport {
	constructor(
		private readonly endpoint: string,
		private readonly token: string,
		private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
		/** Wraps each request, used to keep reports out of the bot's own traces. */
		private readonly wrap: <T>(fn: () => T) => T = (fn) => fn(),
	) {}

	async send(report: TelemetryReport): Promise<SendResult> {
		let response: RawResponse;

		try {
			const body = JSON.stringify(report);

			response = await this.wrap(() => this.post(body));
		} catch (error) {
			return {
				ok: false,
				fatal: false,
				discard: false,
				retryAfterMs: undefined,
				status: undefined,
				reason: error instanceof Error ? error.message : String(error),
			};
		}

		if (response.status >= 200 && response.status < 300) {
			return { ok: true, config: parseConfig(response.body) };
		}

		const retryAfter = Number(response.retryAfter);

		return {
			ok: false,
			fatal: response.status === 401 || response.status === 403,
			// 404 and 5xx can come from a deploy in progress, retry them; other 4xx will fail again
			discard: response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 429,
			retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
			status: response.status,
			reason: `HTTP ${response.status} ${response.body.slice(0, 300)}`,
		};
	}

	private post(body: string): Promise<RawResponse> {
		const headers = {
			Authorization: `Bearer ${this.token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
			"x-upbot-package-version": PACKAGE_VERSION,
		};

		if (typeof globalThis.fetch === "function") {
			return this.postWithFetch(body, headers);
		}

		return this.postWithNodeHttp(body, headers);
	}

	private async postWithFetch(body: string, headers: Record<string, string>): Promise<RawResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await fetch(this.endpoint, { method: "POST", headers, body, signal: controller.signal });

			return {
				status: response.status,
				retryAfter: response.headers.get("retry-after"),
				body: await response.text(),
			};
		} finally {
			clearTimeout(timer);
		}
	}

	/** Node.js 16 has no global fetch, discord.js 14 still supports it. */
	private async postWithNodeHttp(body: string, headers: Record<string, string>): Promise<RawResponse> {
		const url = new URL(this.endpoint);
		const http = url.protocol === "https:" ? await import("node:https") : await import("node:http");

		return new Promise((resolve, reject) => {
			const request = http.request(
				url,
				{ method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, timeout: this.timeoutMs },
				(response) => {
					let data = "";

					response.setEncoding("utf8");
					response.on("data", (chunk: string) => {
						data += chunk;
					});
					response.on("end", () => {
						const retryAfter = response.headers["retry-after"];

						resolve({
							status: response.statusCode ?? 0,
							retryAfter: Array.isArray(retryAfter) ? (retryAfter[0] ?? null) : (retryAfter ?? null),
							body: data,
						});
					});
				},
			);

			request.on("timeout", () => request.destroy(new Error(`Request timed out after ${this.timeoutMs}ms`)));
			request.on("error", reject);
			request.end(body);
		});
	}
}

function parseConfig(body: string): RemoteConfig | undefined {
	if (!body) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(body);

		return parsed && typeof parsed === "object" ? (parsed as RemoteConfig) : undefined;
	} catch {
		return undefined;
	}
}
