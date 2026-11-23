import { afterAll, beforeAll, expect, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
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
