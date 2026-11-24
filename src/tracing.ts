import type * as OtelApi from "@opentelemetry/api";
import { logger } from "./logger.ts";
import { PACKAGE_VERSION } from "./utils/version.ts";

const SUPPRESS_TRACING_KEY = "OpenTelemetry SDK Context Key SUPPRESS_TRACING";

export interface InteractionSpan {
	/** Runs the interaction listeners inside the span, so database and HTTP spans attach to it. */
	run<T>(fn: () => T): T;
	end(error?: unknown): void;
}

/**
 * Optional OpenTelemetry support. Nothing happens unless the bot installed `@opentelemetry/api`
 * and registered a tracer provider (for example the OpenTelemetry Node SDK).
 */
export class Tracing {
	private api: typeof OtelApi | undefined;
	private tracer: OtelApi.Tracer | undefined;

	async load(): Promise<void> {
		try {
			this.api = await import("@opentelemetry/api");
			this.tracer = this.api.trace.getTracer("@upbothq/discord-bot-monitoring", PACKAGE_VERSION);
		} catch {
			logger.debug("@opentelemetry/api is not installed, interactions are not traced");
		}
	}

	/**
	 * Runs `fn` with tracing suppressed, so the reports of this library do not show up as traces
	 * of the bot (the fetch and HTTP auto-instrumentations would trace every one of them).
	 */
	untraced<T>(fn: () => T): T {
		const api = this.api;

		if (!api) {
			return fn();
		}

		// Same key as suppressTracing() of @opentelemetry/core: context keys are Symbol.for() of
		// their description, so this works without depending on the core package
		const key = api.createContextKey(SUPPRESS_TRACING_KEY);

		return api.context.with(api.context.active().setValue(key, true), fn);
	}

	start(name: string, attributes: Record<string, string | number>): InteractionSpan | undefined {
		const api = this.api;
		const tracer = this.tracer;

		if (!api || !tracer) {
			return undefined;
		}

		// Every interaction starts its own trace, whatever context the gateway message ran in
		const span = tracer.startSpan(
			name,
			{ kind: api.SpanKind.SERVER, attributes },
			api.ROOT_CONTEXT,
		);

		if (!span.isRecording()) {
			return undefined;
		}

		const context = api.trace.setSpan(api.ROOT_CONTEXT, span);
		let ended = false;

		return {
			run: (fn) => api.context.with(context, fn),
			end: (error) => {
				if (ended) {
					return;
				}

				ended = true;

				if (error !== undefined) {
					const message = error instanceof Error ? error.message : JSON.stringify(error);

					span.setStatus({ code: api.SpanStatusCode.ERROR, message });

					if (error instanceof Error) {
						span.recordException(error);
					}
				}

				span.end();
			},
		};
	}
}
