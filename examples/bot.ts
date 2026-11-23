const { Client, GatewayIntentBits } = require("discord.js");
const { ShardMonitor } = require("@upbothq/discord-bot-monitoring");

// This file is spawned as a shard by shard.js (ShardingManager).
// client.shard is only available in this context, which is required by ShardMonitor.
const client = new Client({
	intents: [GatewayIntentBits.Guilds],
});

// Initialize the ShardMonitor inside the shard process
const monitor = new ShardMonitor({
	client,
	token: process.env.UPBOT_TOKEN,
	endpoint: process.env.UPBOT_ENDPOINT,
});

console.log("Shard process started, waiting for clientReady event...");
// console.log(monitor);

client.once("clientReady", () => {
	console.log(`Logged in as ${client.user?.tag}!`);
	  if (client.shard?.ids?.includes(0)) {
		process.exit(1);
    // setTimeout(() => {
    //   throw new Error("Intentional shard crash for testing");
    // }, 15000);
  }

});

// Login to Discord with your bot's token
client.login(process.env.DISCORD_BOT_TOKEN);