import * as nodeModule from "node:module";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations, type InstrumentationConfigMap } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { logger } from "./logger.ts";

/**
 * OpenTelemetry setup for Discord bots, sending traces to Upbot.
 *
 * Call it before the bot loads its other modules, so the database and HTTP libraries get
 * instrumented: first line of the entry file, or `--import`/`--require` of the register entry.
 */

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
	/** Share of the traces to keep, from 0 to 1. Defaults to UPBOT_TRACES_SAMPLE_RATE, then 1. */
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

type HookedConfig = { ignoreOutgoingRequestHook?: (request: never) => boolean; ignoreRequestHook?: (request: never) => boolean };

/** Default settings per instrumentation, the ones passed in `instrumentations` are merged over them. */
function defaultInstrumentations(overrides: InstrumentationConfigMap = {}): InstrumentationConfigMap {
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

/**
 * Keeps a share of the traces, decided once per trace from its id; spans follow their parent,
 * so a kept interaction keeps all its database and HTTP spans.
 */
function ratioSampler(rate: number): Sampler {
	const bound = Math.floor(Math.min(Math.max(rate, 0), 1) * 0xffffffff);

	return {
		shouldSample(context, traceId) {
			const parent = trace.getSpanContext(context);

			if (parent !== undefined && isSpanContextValid(parent)) {
				return { decision: (parent.traceFlags & SAMPLED_FLAG) === SAMPLED_FLAG ? RECORD_AND_SAMPLED : NOT_RECORD };
			}

			const accumulated = Number.parseInt(traceId.slice(-8), 16);

			return { decision: accumulated <= bound ? RECORD_AND_SAMPLED : NOT_RECORD };
		},
		toString() {
			return `UpbotRatioSampler{${rate}}`;
		},
	} as Sampler;
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
	const register = (nodeModule as { register?: (specifier: string, parentURL?: string) => void }).register;

	if (typeof register !== "function") {
		return;
	}

	try {
		const fromHere = createRequire(import.meta.url);
		const fromInstrumentations = createRequire(fromHere.resolve("@opentelemetry/auto-instrumentations-node"));

		register(pathToFileURL(fromInstrumentations.resolve("@opentelemetry/instrumentation/hook.mjs")).href);
	} catch (error) {
		logger.debug("ES modules will not be instrumented, the loader hook could not be registered", error);
	}
}

/**
 * Starts OpenTelemetry once per process. Returns the SDK, to `await sdk.shutdown()` before exiting
 * if the last spans matter.
 */
export function startTracing(options: TracingOptions = {}): NodeSDK | undefined {
	const scope = globalThis as GlobalWithSdk;

	if (scope[SDK_KEY]) {
		return scope[SDK_KEY];
	}

	const token = options.token ?? process.env.UPBOT_TOKEN;

	if (!token) {
		logger.error("startTracing: no token, pass `token` or set UPBOT_TOKEN — tracing is disabled");

		return undefined;
	}

	if (options.esm !== false) {
		registerEsmHook();
	}

	const sdk = new NodeSDK({
		instrumentations: [getNodeAutoInstrumentations(defaultInstrumentations(options.instrumentations))],
		sampler: ratioSampler(options.sampleRate ?? readRate(process.env.UPBOT_TRACES_SAMPLE_RATE) ?? 1),
		serviceName: options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "discord-bot",
		traceExporter: new OTLPTraceExporter({
			headers: { Authorization: `Bearer ${token}` },
			url: options.endpoint ?? process.env.UPBOT_TRACES_ENDPOINT ?? DEFAULT_TRACES_ENDPOINT,
		}),
	});

	sdk.start();
	scope[SDK_KEY] = sdk;

	return sdk;
}
