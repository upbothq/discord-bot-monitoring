import { afterEach, expect, spyOn, test } from "bun:test";
import { DISABLED_INSTRUMENTATIONS, startTracing } from "../src/otel.ts";

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
