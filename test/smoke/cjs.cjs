// Loads the built package through its exports map, as a CommonJS bot would, on any runtime
const assert = require("node:assert/strict");
const { Client, version } = require("discord.js");
const { BotMonitor, ShardMonitor } = require("@upbothq/discord-bot-monitoring");
const { startTracing } = require("@upbothq/discord-bot-monitoring/otel");

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

Promise.resolve(client.destroy()).then(() => {
	console.log(`CJS ok with discord.js ${version}`);
});
