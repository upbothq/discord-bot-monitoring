import { expect, test } from "bun:test";
import { RateLimitCollector } from "../src/collectors/rate-limits.ts";
import { FakeClient } from "./helpers.ts";

test("aggregates rate limits per route and counts invalid requests", () => {
	const client = new FakeClient();
	const collector = new RateLimitCollector(client.asClient());

	collector.register();

	client.rest.emit("rateLimited", {
		route: "/channels/:id/messages",
		method: "post",
		global: false,
		scope: "user",
		retryAfter: 800,
	});
	client.rest.emit("rateLimited", {
		route: "/channels/:id/messages",
		method: "post",
		global: false,
		scope: "user",
		retryAfter: 1200,
	});
	client.rest.emit("rateLimited", {
		route: "/guilds/:id",
		method: "get",
		global: true,
		retryAfter: 50,
	});

	client.rest.emit("response", {}, { status: 401, headers: new Headers() });
	client.rest.emit("response", {}, { status: 403, headers: new Headers() });
	client.rest.emit(
		"response",
		{},
		{ status: 429, headers: new Headers({ "x-ratelimit-scope": "user" }) },
	);
	client.rest.emit(
		"response",
		{},
		{ status: 429, headers: new Headers({ "x-ratelimit-scope": "shared" }) },
	);
	client.rest.emit("response", {}, { status: 200, headers: new Headers() });
	// @discordjs/rest 1.x passes undici response data
	client.rest.emit("response", {}, { statusCode: 403, headers: {} });

	const { rateLimits, invalidRequests } = collector.snapshot();

	expect(invalidRequests).toBe(4);
	expect(rateLimits).toEqual([
		{
			route: "/channels/:id/messages",
			method: "POST",
			scope: "user",
			global: false,
			hits: 2,
			max_retry_after_ms: 1200,
		},
		{
			route: "global",
			method: "GET",
			scope: "global",
			global: true,
			hits: 1,
			max_retry_after_ms: 50,
		},
	]);
	expect(collector.snapshot()).toEqual({ rateLimits: [], invalidRequests: 0 });
});

test("stops listening once unregistered", () => {
	const client = new FakeClient();
	const collector = new RateLimitCollector(client.asClient());

	collector.register();
	collector.unregister();

	expect(client.rest.listenerCount("rateLimited")).toBe(0);
	expect(client.rest.listenerCount("response")).toBe(0);
});
