import { describe, expect, test } from "bun:test";
import { InteractionCollector } from "../src/collectors/interactions.ts";
import { button, chatInput, FakeClient, sleep } from "./helpers.ts";

function setup(ackDeadlineMs = 3_000) {
	const client = new FakeClient();
	const collector = new InteractionCollector(client.asClient(), undefined, undefined, ackDeadlineMs);

	collector.register();

	return { client, collector };
}

describe("InteractionCollector", () => {
	test("counts a call and its response time, with the subcommand in the name", async () => {
		const { client, collector } = setup();

		client.on("interactionCreate", (interaction: { reply: () => Promise<void> }) => {
			void interaction.reply();
		});
		client.emit("interactionCreate", chatInput("ticket", "create"));
		await sleep(0);

		const [metric] = collector.snapshot();

		expect(metric).toMatchObject({ type: "chat_input", name: "/ticket create", calls: 1, errors: 0, unanswered: 0 });
		expect(metric?.latency_buckets[0]).toBe(1);
		expect(collector.snapshot()).toEqual([]);
	});

	test("sees interactions even when the bot listens before the library starts", async () => {
		const client = new FakeClient();

		client.on("interactionCreate", (interaction: { reply: () => Promise<void> }) => {
			void interaction.reply();
		});

		const collector = new InteractionCollector(client.asClient(), undefined, undefined, 20);
		collector.register();
		client.emit("interactionCreate", chatInput("ping"));
		await sleep(40);

		expect(collector.snapshot()[0]).toMatchObject({ calls: 1, unanswered: 0 });
	});

	test("counts interactions nobody acknowledged before the deadline", async () => {
		const { client, collector } = setup(20);

		client.emit("interactionCreate", chatInput("slow"));
		await sleep(40);

		expect(collector.snapshot()[0]).toMatchObject({ calls: 1, unanswered: 1 });
	});

	test("a deferred interaction is not unanswered", async () => {
		const { client, collector } = setup(20);

		client.on("interactionCreate", (interaction: { deferReply: () => Promise<void> }) => {
			void interaction.deferReply();
		});
		client.emit("interactionCreate", chatInput("long"));
		await sleep(40);

		expect(collector.snapshot()[0]).toMatchObject({ calls: 1, unanswered: 0 });
	});

	test("records failed responses by error code and still rejects for the bot", async () => {
		const { client, collector } = setup();
		const interaction = chatInput("late");
		let caught: unknown;

		interaction.reply = () => Promise.reject(Object.assign(new Error("Unknown interaction"), { code: 10062 }));
		client.on("interactionCreate", async (received: { reply: () => Promise<void> }) => {
			try {
				await received.reply();
			} catch (error) {
				caught = error;
			}
		});
		client.emit("interactionCreate", interaction);
		await sleep(0);

		expect((caught as { code: number }).code).toBe(10062);
		expect(collector.snapshot()[0]).toMatchObject({ errors: 1, error_codes: { "10062": 1 } });
	});

	test("groups dynamic custom ids", async () => {
		const { client, collector } = setup();

		client.on("interactionCreate", (interaction: { update: () => Promise<void> }) => {
			void interaction.update();
		});
		client.emit("interactionCreate", button("ticket:close:123456789012345678"));
		client.emit("interactionCreate", button("ticket:close:876543210987654321"));
		await sleep(0);

		expect(collector.snapshot()).toMatchObject([{ type: "button", name: "ticket:close:*", calls: 2 }]);
	});

	test("caps the number of distinct names", () => {
		const { client, collector } = setup();

		for (let index = 0; index < 250; index++) {
			client.emit("interactionCreate", chatInput(`command${index}`));
		}

		const metrics = collector.snapshot();

		expect(metrics).toHaveLength(201);
		expect(metrics.find((metric) => metric.name === "(other)")?.calls).toBe(50);
	});

	test("metrics that could not be sent are merged back", () => {
		const { client, collector } = setup();

		client.emit("interactionCreate", chatInput("ping"));
		const unsent = collector.snapshot();
		client.emit("interactionCreate", chatInput("ping"));
		collector.restore(unsent);

		expect(collector.snapshot()[0]?.calls).toBe(2);
	});

	test("unregister gives emit back", () => {
		const client = new FakeClient();
		const original = client.emit;
		const collector = new InteractionCollector(client.asClient(), undefined);

		collector.register();
		expect(client.emit).not.toBe(original);

		collector.unregister();
		expect(client.emit).toBe(original);
	});
});
