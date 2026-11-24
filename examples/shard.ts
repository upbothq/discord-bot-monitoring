import { ShardingManager } from "discord.js";

// Spawns bot.ts once per shard, the monitor starts inside each shard process
const manager = new ShardingManager("./bot.ts", {
	token: process.env.DISCORD_BOT_TOKEN,
	totalShards: 3,
});

manager.on("shardCreate", (shard) => {
	console.log(`Launched shard ${shard.id}`);
});

manager.spawn();
