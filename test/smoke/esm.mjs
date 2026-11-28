// Loads the built package through its exports map, as an ESM bot would, on any runtime
import assert from "node:assert/strict";
import { Client, version } from "discord.js";
import { BotMonitor, ShardMonitor } from "@upbothq/discord-bot-monitoring";
import { startTracing } from "@upbothq/discord-bot-monitoring/otel";

assert.equal(BotMonitor, ShardMonitor);
assert.equal(typeof startTracing, "function");

const [major = 0, minor = 0] = version.split(".").map(Number);
const readyEvent = major > 14 || (major === 14 && minor >= 22) ? "clientReady" : "ready";
const client = new Client({ intents: [] });
const monitor = new BotMonitor({ client, token: "smoke", endpoint: "http://127.0.0.1:9" });

assert.equal(
	client.listenerCount(readyEvent),
	1,
	`waits for "${readyEvent}" on discord.js ${version}`,
);

monitor.destroy();
assert.equal(client.listenerCount(readyEvent), 0);
await client.destroy();

console.log(`ESM ok with discord.js ${version}`);
