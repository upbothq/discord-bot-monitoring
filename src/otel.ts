import * as nodeModule from "node:module";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import {
	getNodeAutoInstrumentations,
	type InstrumentationConfigMap,
} from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { logger } from "./logger.ts";
import { remoteSampling } from "./sampling.ts";

export const DEFAULT_TRACES_ENDPOINT = "https://dash.upbot.app/api/otlp/v1/traces";

/**
 * Instrumentations turned off unless re-enabled in `instrumentations`:
 * dns and net add a lookup and a connect span to every HTTP call, fs one per file access.
 */
export const DISABLED_INSTRUMENTATIONS: readonly string[] = [
	"@opentelemetry/instrumentation-dns",
	"@opentelemetry/instrumentation-net",
	"@opentelemetry/instrumentation-fs",
];

export interface TracingOptions {
	/** Monitor token. Defaults to UPBOT_TOKEN. */
	token?: string;
	/** OTLP/HTTP traces endpoint. Defaults to UPBOT_TRACES_ENDPOINT, then Upbot. */
	endpoint?: string;
	/** Name of the bot in the traces. Defaults to OTEL_SERVICE_NAME, then "discord-bot". */
	serviceName?: string;
	/** Share of the traces to keep, from 0 to 1. Defaults to UPBOT_TRACES_SAMPLE_RATE, then 1. The dashboard can lower it, not raise it. */
	sampleRate?: number;
	/** Per instrumentation settings, merged over the defaults, e.g. { "@opentelemetry/instrumentation-fs": { enabled: true } }. */
	instrumentations?: InstrumentationConfigMap;
	/** Register the ES module loader hook. Defaults to true, turn it off if it conflicts with another loader. */
	esm?: boolean;
}

/**
 * The gateway websocket: its handshake is an HTTP request that would open a trace, and every
 * gateway message (interactions, events) would then run inside it. Resume URLs use other
 * gateway hosts, e.g. gateway-us-east1-b.discord.gg.
 */
export function isDiscordGateway(host: string | undefined | null): boolean {
	if (!host) {
		return false;
	}

	const hostname = host.replace(/^wss?:\/\/|^https?:\/\//, "").split(/[/:]/)[0] ?? "";

	return /^gateway[\w-]*\.discord\.gg$/.test(hostname);
}

type HookedConfig = {
	ignoreOutgoingRequestHook?: (request: never) => boolean;
	ignoreRequestHook?: (request: never) => boolean;
};

/** Default settings per instrumentation, the ones passed in `instrumentations` are merged over them. */
function defaultInstrumentations(
	overrides: InstrumentationConfigMap = {},
): InstrumentationConfigMap {
	const config: Record<string, Record<string, unknown>> = Object.fromEntries(
		DISABLED_INSTRUMENTATIONS.map((name) => [name, { enabled: false }]),
	);

	const custom = overrides as Record<string, HookedConfig | undefined>;
	const userHttpHook = custom["@opentelemetry/instrumentation-http"]?.ignoreOutgoingRequestHook as
		| ((request: { hostname?: string | null; host?: string | null }) => boolean)
		| undefined;
	const userUndiciHook = custom["@opentelemetry/instrumentation-undici"]?.ignoreRequestHook as
		| ((request: { origin: string }) => boolean)
		| undefined;

	for (const [name, value] of Object.entries(overrides)) {
		config[name] = { ...config[name], ...(value as Record<string, unknown>) };
	}

	config["@opentelemetry/instrumentation-http"] = {
		...config["@opentelemetry/instrumentation-http"],
		ignoreOutgoingRequestHook: (request: { hostname?: string | null; host?: string | null }) =>
			isDiscordGateway(request.hostname ?? request.host) || (userHttpHook?.(request) ?? false),
	};
	config["@opentelemetry/instrumentation-undici"] = {
		...config["@opentelemetry/instrumentation-undici"],
		ignoreRequestHook: (request: { origin: string }) =>
			isDiscordGateway(request.origin) || (userUndiciHook?.(request) ?? false),
	};

	return config as InstrumentationConfigMap;
}

type Sampler = NonNullable<NodeSDKConfiguration["sampler"]>;

// SamplingDecision of @opentelemetry/sdk-trace-base, stable across versions
const NOT_RECORD = 0;
const RECORD_AND_SAMPLED = 2;
const SAMPLED_FLAG = 1;

// SpanStatusCode.ERROR and ExportResultCode.SUCCESS, stable across versions
const ERROR_STATUS = 2;
const EXPORT_SUCCESS = 0;

/** Traces held back at most, waiting to know whether they fail; the oldest are dropped first. */
const MAX_HELD_TRACES = 2000;

/** Spans held back at most, whatever their traces: keeps the memory of a busy bot bounded. */
const MAX_HELD_SPANS = 10_000;

type SpanExporter = NonNullable<NodeSDKConfiguration["traceExporter"]>;
type ReadableSpans = Parameters<SpanExporter["export"]>[0];

/** The fields read from an ended span, named differently across SDK versions for the parent. */
type EndedSpan = {
	spanContext(): { traceId: string };
	status: { code: number };
	parentSpanId?: string;
	parentSpanContext?: unknown;
};

function inRatio(traceId: string, rate: number): boolean {
	const bound = Math.floor(Math.min(Math.max(rate, 0), 1) * 0xffffffff);

	return Number.parseInt(traceId.slice(-8), 16) <= bound;
}

/**
 * Traces outside the sample rate that are still recorded because failed traces are kept: their
 * spans wait here and are only exported once one of them fails.
 */
export class HeldTraces {
	// null once the root span ended without an error: later spans of the trace are dropped too
	private readonly traces = new Map<string, EndedSpan[] | null>();
	private heldSpans = 0;

	/** Spans currently held back, for the tests. */
	get size(): number {
		return this.heldSpans;
	}

	hold(traceId: string): void {
		if (this.traces.size >= MAX_HELD_TRACES) {
			const oldest = this.traces.keys().next().value;

			if (oldest !== undefined) {
				this.heldSpans -= this.traces.get(oldest)?.length ?? 0;
				this.traces.delete(oldest);
			}
		}

		this.traces.set(traceId, []);
	}

	/** Drops the oldest held traces until the spans fit again; their later spans are dropped too. */
	private evictSpans(): void {
		for (const [traceId, held] of this.traces) {
			if (this.heldSpans <= MAX_HELD_SPANS) {
				return;
			}

			if (held !== null) {
				this.heldSpans -= held.length;
				this.traces.set(traceId, null);
			}
		}
	}

	/** Returns the spans to export now, keeping back the ones of traces that did not fail yet. */
	release(spans: readonly EndedSpan[]): EndedSpan[] {
		const ready: EndedSpan[] = [];

		for (const span of spans) {
			const traceId = span.spanContext().traceId;
			const held = this.traces.get(traceId);

			if (held === undefined) {
				ready.push(span);
			} else if (held === null) {
				continue;
			} else if (span.status.code === ERROR_STATUS) {
				// The trace failed: send what was held, the spans after it are not held anymore
				this.heldSpans -= held.length;
				this.traces.delete(traceId);
				ready.push(...held, span);
			} else if (!(span.parentSpanContext ?? span.parentSpanId)) {
				this.heldSpans -= held.length;
				this.traces.set(traceId, null);
			} else {
				held.push(span);
				this.heldSpans++;
				this.evictSpans();
			}
		}

		return ready;
	}
}

/**
 * Keeps a share of the traces, decided once per trace from its id; spans follow their parent,
 * so a kept interaction keeps all its database and HTTP spans. The rate is the lowest of the local
 * one and the one the dashboard sends, read for every new trace so it changes without a restart.
 */
export function upbotSampler(localRate: number, held: HeldTraces): Sampler {
	return {
		shouldSample(context, traceId) {
			const parent = trace.getSpanContext(context);

			if (parent !== undefined && isSpanContextValid(parent)) {
				return {
					decision:
						(parent.traceFlags & SAMPLED_FLAG) === SAMPLED_FLAG ? RECORD_AND_SAMPLED : NOT_RECORD,
				};
			}

			const remote = remoteSampling();

			if (inRatio(traceId, Math.min(localRate, remote?.rate ?? 1))) {
				return { decision: RECORD_AND_SAMPLED };
			}

			if (!remote?.errorsOnly) {
				return { decision: NOT_RECORD };
			}

			// Whether it fails is only known once its spans end
			held.hold(traceId);

			return { decision: RECORD_AND_SAMPLED };
		},
		toString() {
			return `UpbotSampler{${localRate}}`;
		},
	} as Sampler;
}

/** Leaves out the spans of held traces until they fail. */
export function holdingExporter(exporter: SpanExporter, held: HeldTraces): SpanExporter {
	return {
		export(spans, resultCallback) {
			const ready = held.release(spans as unknown as EndedSpan[]);

			if (ready.length === 0) {
				resultCallback({ code: EXPORT_SUCCESS });

				return;
			}

			exporter.export(ready as unknown as ReadableSpans, resultCallback);
		},
		shutdown: () => exporter.shutdown(),
		forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
	};
}

function readRate(value: string | undefined): number | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}

	const rate = Number(value);

	return Number.isFinite(rate) ? rate : undefined;
}

/**
 * One SDK per process. Kept on globalThis because the CommonJS build bundles this module twice
 * (register and otel entries), each with its own module scope.
 */
const SDK_KEY = Symbol.for("@upbothq/discord-bot-monitoring/tracing");

type GlobalWithSdk = typeof globalThis & { [SDK_KEY]?: NodeSDK };

/**
 * ES modules are only instrumented through a loader hook, usually passed with `--import`, which
 * hosts like Pelican do not allow. Registering it at runtime covers every module imported after,
 * so an ESM bot loads its code with `await import()` once tracing started.
 */
function registerEsmHook(): void {
	const register = (nodeModule as { register?: (specifier: string, parentURL?: string) => void })
		.register;

	if (typeof register !== "function") {
		return;
	}

	try {
		const fromHere = createRequire(import.meta.url);
		const fromInstrumentations = createRequire(
			fromHere.resolve("@opentelemetry/auto-instrumentations-node"),
		);

		register(
			pathToFileURL(fromInstrumentations.resolve("@opentelemetry/instrumentation/hook.mjs")).href,
		);
	} catch (error) {
		logger.debug(
			"ES modules will not be instrumented, the loader hook could not be registered",
			error,
		);
	}
}

/**
 * Starts OpenTelemetry once per process, sending traces to Upbot. Call it before the bot loads its
 * other modules, so the database and HTTP libraries get instrumented. Returns the SDK, to
 * `await sdk.shutdown()` before exiting if the last spans matter.
 */
export function startTracing(options: TracingOptions = {}): NodeSDK | undefined {
	const scope = globalThis as GlobalWithSdk;

	if (scope[SDK_KEY]) {
		return scope[SDK_KEY];
	}

	const token = options.token ?? process.env.UPBOT_TOKEN;

	if (!token) {
		logger.error("startTracing: no token, pass `token` or set UPBOT_TOKEN, tracing is disabled");

		return undefined;
	}

	if (options.esm !== false) {
		registerEsmHook();
	}

	const held = new HeldTraces();

	const sdk = new NodeSDK({
		instrumentations: [
			getNodeAutoInstrumentations(defaultInstrumentations(options.instrumentations)),
		],
		sampler: upbotSampler(
			options.sampleRate ?? readRate(process.env.UPBOT_TRACES_SAMPLE_RATE) ?? 1,
			held,
		),
		serviceName: options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "discord-bot",
		traceExporter: holdingExporter(
			new OTLPTraceExporter({
				headers: { Authorization: `Bearer ${token}` },
				url: options.endpoint ?? process.env.UPBOT_TRACES_ENDPOINT ?? DEFAULT_TRACES_ENDPOINT,
			}),
			held,
		),
	});

	sdk.start();
	scope[SDK_KEY] = sdk;

	return sdk;
}
