import { afterEach, expect, spyOn, test } from "bun:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import {
	DISABLED_INSTRUMENTATIONS,
	HeldTraces,
	holdingExporter,
	isDiscordGateway,
	startTracing,
	upbotSampler,
} from "../src/otel.ts";
import { setRemoteSampling } from "../src/sampling.ts";

afterEach(() => {
	delete process.env.UPBOT_TOKEN;
	setRemoteSampling(undefined);
});

// The sampler reads the last 8 hex digits of the trace id: 0 is always kept, ffffffff only at rate 1
const KEPT = "0123456789abcdef0123456700000000";
const DROPPED = "0123456789abcdef01234567ffffffff";

function decide(sampler: ReturnType<typeof upbotSampler>, traceId: string): number {
	return sampler.shouldSample(ROOT_CONTEXT, traceId, "span", 0, {}, []).decision;
}

function span(traceId: string, options: { error?: boolean; root?: boolean } = {}) {
	return {
		spanContext: () => ({ traceId }),
		status: { code: options.error ? 2 : 0 },
		parentSpanId: options.root ? undefined : "parent",
	};
}

test("does not start without a token", () => {
	const error = spyOn(console, "error").mockImplementation(() => {});

	expect(startTracing()).toBeUndefined();
	expect(error).toHaveBeenCalledTimes(1);
	error.mockRestore();
});

test("turns off the noisy instrumentations by default", () => {
	expect(DISABLED_INSTRUMENTATIONS).toEqual([
		"@opentelemetry/instrumentation-dns",
		"@opentelemetry/instrumentation-net",
		"@opentelemetry/instrumentation-fs",
	]);
});

test("recognizes the gateway websocket hosts, not the REST API", () => {
	expect(isDiscordGateway("gateway.discord.gg")).toBe(true);
	expect(isDiscordGateway("https://gateway.discord.gg")).toBe(true);
	expect(isDiscordGateway("wss://gateway-us-east1-b.discord.gg/?v=10")).toBe(true);
	expect(isDiscordGateway("gateway.discord.gg:443")).toBe(true);
	expect(isDiscordGateway("discord.com")).toBe(false);
	expect(isDiscordGateway("https://discord.com")).toBe(false);
	expect(isDiscordGateway(undefined)).toBe(false);
});

test("samples at the local rate until the dashboard sends one", () => {
	const sampler = upbotSampler(1, new HeldTraces());

	expect(decide(sampler, DROPPED)).toBe(2);

	setRemoteSampling({ rate: 0.5, errorsOnly: false });

	expect(decide(sampler, DROPPED)).toBe(0);
	expect(decide(sampler, KEPT)).toBe(2);
});

test("lets the dashboard lower the local rate, not raise it", () => {
	const sampler = upbotSampler(0, new HeldTraces());

	setRemoteSampling({ rate: 1, errorsOnly: false });

	expect(decide(sampler, DROPPED)).toBe(0);
});

test("exports held traces only when they fail", async () => {
	const held = new HeldTraces();
	const sampler = upbotSampler(1, held);
	const exported: unknown[] = [];
	const exporter = holdingExporter(
		{
			export: (spans, done) => {
				exported.push(...spans);
				done({ code: 0 });
			},
			shutdown: async () => {},
		},
		held,
	);
	const send = (spans: unknown[]) =>
		exporter.export(spans as Parameters<typeof exporter.export>[0], () => {});

	setRemoteSampling({ rate: 0, errorsOnly: true });

	const failing = "0123456789abcdef01234567fffffffe";

	expect(decide(sampler, DROPPED)).toBe(2);
	expect(decide(sampler, failing)).toBe(2);

	const ok = [span(DROPPED), span(DROPPED, { root: true })];
	const failed = [span(failing), span(failing, { error: true }), span(failing, { root: true })];

	send([ok[0], failed[0]]);
	expect(exported).toEqual([]);

	send([ok[1], failed[1], failed[2]]);
	expect(exported).toEqual([failed[0], failed[1], failed[2]]);

	// A late span of the dropped trace stays out
	send([span(DROPPED)]);
	expect(exported).toHaveLength(3);
});

test("keeps the held spans bounded, dropping the oldest traces", () => {
	const held = new HeldTraces();
	const first = "0123456789abcdef0123456700000001";
	const second = "0123456789abcdef0123456700000002";

	held.hold(first);
	held.hold(second);
	held.release(Array.from({ length: 9_000 }, () => span(first)));
	held.release(Array.from({ length: 2_000 }, () => span(second)));

	// The first trace made room: its spans are gone, and so are the ones that come later
	expect(held.size).toBe(2_000);
	expect(held.release([span(first, { error: true })])).toEqual([]);

	// The root of the second ends without an error: nothing is left
	held.release([span(second, { root: true })]);
	expect(held.size).toBe(0);
});
