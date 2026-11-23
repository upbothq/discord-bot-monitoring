import { afterAll, beforeAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { EventTracer } from "../src/collectors/events.ts";
import { InteractionCollector } from "../src/collectors/interactions.ts";
import { Tracing } from "../src/tracing.ts";
import { chatInput, FakeClient, sleep } from "./helpers.ts";

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
	const provider = new BasicTracerProvider();

	provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
	context.setGlobalContextManager(contextManager.enable());
	trace.setGlobalTracerProvider(provider);
});

afterAll(() => {
	trace.disable();
	context.disable();
});

test("database spans of the bot become children of the interaction span", async () => {
	const tracing = new Tracing();
	await tracing.load();

	const client = new FakeClient();
	const collector = new InteractionCollector(client.asClient(), tracing);
	collector.register();

	client.on("interactionCreate", async (interaction: { reply: () => Promise<void> }) => {
		await sleep(5);
		// What an auto-instrumented database driver does on a query
		trace.getTracer("pg").startActiveSpan("SELECT tickets", (span) => span.end());
		await interaction.reply();
	});

	client.emit("interactionCreate", chatInput("ticket", "list"));
	await sleep(30);

	const spans = exporter.getFinishedSpans();
	const root = spans.find((span) => span.name === "interaction /ticket list");
	const query = spans.find((span) => span.name === "SELECT tickets");

	expect(root?.attributes["discord.interaction.type"]).toBe("chat_input");
	expect(query?.parentSpanId).toBe(root?.spanContext().spanId);
	expect(query?.spanContext().traceId).toBe(root?.spanContext().traceId);
});

test("reports of the library are never traced", async () => {
	const tracing = new Tracing();
	await tracing.load();
	exporter.reset();

	// What the fetch auto-instrumentation does when the library sends a report
	await tracing.untraced(async () => {
		await sleep(1);
		trace.getTracer("undici").startActiveSpan("POST", (span) => span.end());
	});
	trace.getTracer("undici").startActiveSpan("POST by the bot", (span) => span.end());

	expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["POST by the bot"]);
});

test("each event the bot listens to gets its own trace, lasting until async listeners finish", async () => {
	const tracing = new Tracing();
	await tracing.load();
	exporter.reset();

	const client = new FakeClient();
	const events = new EventTracer(client.asClient(), tracing);
	events.register();

	client.on("messageCreate", async () => {
		await sleep(20);
		trace.getTracer("mongodb").startActiveSpan("find messages", (span) => span.end());
	});

	// A gateway span active while the message arrives must not become its parent
	trace.getTracer("undici").startActiveSpan("GET gateway", (gateway) => {
		client.emit("messageCreate", { guildId: "123" });
		gateway.end();
	});
	await sleep(50);

	const spans = exporter.getFinishedSpans();
	const root = spans.find((span) => span.name === "event messageCreate");
	const query = spans.find((span) => span.name === "find messages");

	expect(root?.parentSpanId).toBeUndefined();
	expect(root?.attributes["discord.event.name"]).toBe("messageCreate");
	expect(root?.attributes["discord.guild.id"]).toBe("123");
	expect(query?.parentSpanId).toBe(root?.spanContext().spanId);
	// The span waited for the listener instead of ending when emit returned
	expect(root?.duration[1] ?? 0).toBeGreaterThan(15_000_000);
	events.unregister();
});

test("events without listeners and internal events are not traced, listeners run as with emit", async () => {
	const tracing = new Tracing();
	await tracing.load();
	exporter.reset();

	const client = new FakeClient();
	const events = new EventTracer(client.asClient(), tracing);
	events.register();

	const calls: string[] = [];
	client.once("guildCreate", () => calls.push("once"));
	client.on("guildCreate", () => calls.push("on"));
	client.on("debug", () => calls.push("debug"));

	expect(client.emit("guildCreate", {})).toBe(true);
	expect(client.emit("guildCreate", {})).toBe(true);
	expect(client.emit("messageDelete", {})).toBe(false);
	client.emit("debug", "heartbeat");

	expect(calls).toEqual(["once", "on", "on", "debug"]);
	expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["event guildCreate", "event guildCreate"]);

	events.unregister();
	expect(client.emit).toBe(EventEmitter.prototype.emit);
});

test("a failing listener marks the event span as an error and still throws", async () => {
	const tracing = new Tracing();
	await tracing.load();
	exporter.reset();

	const client = new FakeClient();
	const events = new EventTracer(client.asClient(), tracing);
	events.register();

	client.on("guildMemberAdd", () => {
		throw new Error("boom");
	});

	expect(() => client.emit("guildMemberAdd", {})).toThrow("boom");
	expect(exporter.getFinishedSpans()[0]?.status.message).toBe("boom");
	events.unregister();
});
