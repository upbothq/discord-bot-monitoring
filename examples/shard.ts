import { ShardingManager } from "discord.js";

// This is the entry point. It spawns bot.ts as individual shard processes.
// ShardMonitor must be initialized inside bot.ts (the shard),
// where client.shard is available.
const manager = new ShardingManager("./bot.ts", {
	token: process.env.DISCORD_BOT_TOKEN,
	totalShards: 3,
	
});

manager.on("shardCreate", (shard) => {
	console.log(`Launched shard ${shard.id}`);
});

manager.spawn();
