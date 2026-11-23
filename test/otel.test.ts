import { afterEach, expect, spyOn, test } from "bun:test";
import { DISABLED_INSTRUMENTATIONS, isDiscordGateway, startTracing } from "../src/otel.ts";

afterEach(() => {
	delete process.env.UPBOT_TOKEN;
});

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
