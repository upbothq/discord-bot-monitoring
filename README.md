<p align="center">
	<a href="https://upbot.app/discord-bot-monitoring">
		<picture>
			<source media="(prefers-color-scheme: dark)" srcset=".github/assets/upbot-logo-dark.svg">
			<img alt="Upbot" src=".github/assets/upbot-logo-light.svg" width="220">
		</picture>
	</a>
</p>

<h1 align="center">Discord Bot Monitoring</h1>

<p align="center">
	<strong>Your Discord bot, seen from the inside.</strong><br>
	Uptime, shards, commands, traces, rate limits and memory for discord.js bots, in your <a href="https://upbot.app">Upbot</a> dashboard.
</p>

<p align="center">
	<a href="https://upbot.app/discord-bot-monitoring">Website</a>
	·
	<a href="https://dash.upbot.app">Dashboard</a>
</p>

---

- **Shards**: status, gateway ping, guilds and members, with a status change reported in under a second.
- **Interactions**: p50/p95 response time, failed responses and commands left without an answer ("The application did not respond").
- **Errors per server**: Discord API errors with the missing permission.
- **Rate limits**: per route, global, and invalid requests before Cloudflare bans your bot.
- **Traces**: your SQL and HTTP calls inside every command, when OpenTelemetry is installed.
- **Memory**: discord.js cache sizes, with advice to make it lighter.

Works with discord.js v14 and v15, on Node.js and Bun, from ESM and CommonJS.

## Get started

1. In the [Upbot dashboard](https://dash.upbot.app), add a **Discord bot** monitor and copy its token.
2. Install the SDK:

```bash
npm install @upbothq/discord-bot-monitoring
```

3. Start the monitor next to your client (in the shard file with a `ShardingManager`):

```ts
import { Client, GatewayIntentBits } from "discord.js";
import { BotMonitor } from "@upbothq/discord-bot-monitoring";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

new BotMonitor({ client, token: process.env.UPBOT_TOKEN });

client.login(process.env.DISCORD_TOKEN);
```

Your bot shows up in Upbot within seconds. `token` defaults to the `UPBOT_TOKEN` environment variable.

## Options

| Option         | Default                   | Description                                     |
| -------------- | ------------------------- | ----------------------------------------------- |
| `token`        | `process.env.UPBOT_TOKEN` | Monitor token from the Upbot dashboard.         |
| `interactions` | `true`                    | Measure interactions.                           |
| `rateLimits`   | `true`                    | Count rate limits and invalid requests.         |
| `tracing`      | `true`                    | Trace interactions when OpenTelemetry is found. |
| `interval`     | `10000`                   | Report interval in milliseconds.                |
| `debug`        | `false`                   | Log what the SDK does.                          |

## Traces

Install OpenTelemetry next to the SDK:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http
```

Then load the `register` entry before discord.js and your database, so their calls get traced:

```ts
// CommonJS: first line of the entry file
require("@upbothq/discord-bot-monitoring/register");

// ES modules: in the file your host starts, then import the bot
import "@upbothq/discord-bot-monitoring/register";
await import("./bot.js");
```

`register` is configured from the environment:

| Variable                   | Default       | Description                                   |
| -------------------------- | ------------- | --------------------------------------------- |
| `UPBOT_TOKEN`              |               | Monitor token from the Upbot dashboard.       |
| `UPBOT_TRACES_SAMPLE_RATE` | `1`           | Share of the traces to send, from `0` to `1`. |
| `OTEL_SERVICE_NAME`        | `discord-bot` | Name of the bot in the traces.                |

To pass options in code instead, call `startTracing()` from `@upbothq/discord-bot-monitoring/otel` with `token`, `sampleRate`, `serviceName` or `instrumentations`.

### Sampling

Each trace is kept or dropped as a whole, so a kept command keeps all its SQL and HTTP spans.

- Choose the share of traces in the bot's **Settings** in the dashboard. The SDK applies it on its next report, within seconds, without a restart.
- Below 100%, failed traces are always sent, so errors are never missed.
- The dashboard can only lower the rate set by `UPBOT_TRACES_SAMPLE_RATE` or `sampleRate`, never raise it.
- Once the plan's monthly trace quota is reached, only failed traces are sent.

This needs `BotMonitor` and tracing in the same process, and version 0.4.0 or later.

---

<p align="center">
	<a href="https://upbot.app">upbot.app</a> · Uptime and performance monitoring for websites, APIs and Discord bots.
</p>
