import { Client, GatewayIntentBits } from "discord.js";
import { BotMonitor } from "@upbothq/discord-bot-monitoring";

// Runs as a standalone bot, or as one shard when spawned by shard.ts
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

new BotMonitor({
	client,
	token: process.env.UPBOT_TOKEN,
	// Unset in production, points to a local dashboard while developing
	endpoint: process.env.UPBOT_ENDPOINT,
	debug: true,
});

client.once("clientReady", () => {
	console.log(`Logged in as ${client.user?.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
