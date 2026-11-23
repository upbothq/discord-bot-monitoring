# @upbothq/discord-bot-monitoring

Monitoring for Discord bots built with discord.js, reported to [Upbot](https://upbot.app):

- **Shards**: status, gateway ping, guilds and members of every shard.
- **Interactions**: calls, response time (p50/p95), failed responses by Discord error code, and interactions nobody answered within 3 seconds ("The application did not respond"). Slash commands with their subcommands, context menus, buttons, select menus, modals and autocomplete.
- **REST API**: rate limits per route, global rate limits and invalid requests (Cloudflare bans a bot after 10 000 in 10 minutes).
- **Traces** (optional): one OpenTelemetry span per interaction, with your database and HTTP calls inside it.

Works with every discord.js v14 release and v15, on Node.js and Bun, from ESM and CommonJS. No runtime dependency.

## Installation

```bash
npm install @upbothq/discord-bot-monitoring
```

## Usage

Create a Discord bot monitor in Upbot, copy its token, then start the monitor next to your client. It works for every bot, sharded or not. With a `ShardingManager`, do this in the shard file.

```ts
import { Client, GatewayIntentBits } from "discord.js";
import { BotMonitor } from "@upbothq/discord-bot-monitoring";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

new BotMonitor({ client, token: process.env.UPBOT_TOKEN });

client.login(process.env.DISCORD_TOKEN);
```

`token` defaults to the `UPBOT_TOKEN` environment variable, so `new BotMonitor({ client })` is enough when it is set. `ShardMonitor` is the same class under its former name.

Each process sends one report every 10 seconds with all the shards it owns. A shard changing status is reported within a second.

### Options

| Option              | Default                                | Description                                                                   |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `client`            |                                        | Your discord.js client.                                                       |
| `token`             | `process.env.UPBOT_TOKEN`              | Monitor token from the Upbot dashboard.                                       |
| `interactions`      | `true`                                 | Measure interactions.                                                         |
| `rateLimits`        | `true`                                 | Count rate limits and invalid requests.                                       |
| `tracing`           | `true`                                 | Open a span per interaction when `@opentelemetry/api` is installed.           |
| `events`            | `true`                                 | Also open a span per Discord event the bot listens to, e.g. `messageCreate`.  |
| `normalizeCustomId` | IDs, snowflakes and UUIDs become `*`   | Groups dynamic custom IDs, e.g. `ticket:close:1234` becomes `ticket:close:*`. |
| `interval`          | `10000`                                | Report interval in milliseconds (5 000 to 120 000).                           |
| `debug`             | `false`                                | Log what the library does.                                                    |
| `endpoint`          | `https://dash.upbot.app/api/telemetry` | Telemetry endpoint.                                                           |

### Shutdown

On `SIGTERM` and `SIGINT` the shards are reported offline. If your bot handles these signals itself, it keeps control of when the process exits. Otherwise the process exits as it would without this library.

```ts
const monitor = new BotMonitor({ client });

await monitor.shutdown(); // report offline, then stop
monitor.destroy(); // stop and remove every listener the library added
```

### Diagnostics

The reports also carry what the dashboard needs to explain problems, with no code to write:

- **Errors per server**: a Discord API error (`50013 Missing Permissions`…) made while handling a command or an event is counted for its server, with the permissions the bot had in that channel. Upbot then shows which permission is missing, or when the role hierarchy is the cause.
- **Deployments**: the version of your code is read from `UPBOT_RELEASE`, else the git commit, else a hash of your source files (outside `node_modules`). Editing the code and restarting is enough for Upbot to compare the new version with the previous one.
- **Memory**: about once a minute, the size of each discord.js cache, the process memory, the intents, sweepers and listened events, so Upbot can recommend a lighter cache setup.

## Traces

The library opens a span named `interaction /command subcommand` for each interaction and runs your `interactionCreate` listeners inside it. Spans of auto-instrumented libraries (PostgreSQL, MySQL, MongoDB, Redis, Prisma, HTTP, fetch…) become its children, so Upbot shows where the time of each command goes.

The Discord events your bot listens to (`messageCreate`, `guildMemberAdd`…) get a span named `event messageCreate` the same way, lasting until their async listeners finish. Internal and very frequent events (`raw`, `debug`, `presenceUpdate`, `typingStart`…) are left out, see `UNTRACED_EVENTS`.

These spans come from the monitor: the `register` entry below only installs OpenTelemetry, so start a `BotMonitor` as well. The gateway websocket itself is never traced.

Install OpenTelemetry:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http
```

Then start tracing **before the bot loads anything else**, so the database and HTTP libraries get instrumented. No change to the start command is needed, which matters on hosts like Pelican or Pterodactyl.

**CommonJS** (`require`): make it the first line of the entry file.

```js
require("@upbothq/discord-bot-monitoring/register");

const { Client } = require("discord.js");
// ...
```

**ES modules** (`import`): static imports all load before any code runs, so the entry file starts tracing, then loads the bot.

```js
// index.js, the file your host starts
import "@upbothq/discord-bot-monitoring/register";

await import("./bot.js");
```

The register entry reads its settings from the environment:

| Variable                   | Default                                     |
| -------------------------- | ------------------------------------------- |
| `UPBOT_TOKEN`              | required                                    |
| `OTEL_SERVICE_NAME`        | `discord-bot`                               |
| `UPBOT_TRACES_SAMPLE_RATE` | `1`, every trace. `0.1` keeps 10%.          |
| `UPBOT_TRACES_ENDPOINT`    | `https://dash.upbot.app/api/otlp/v1/traces` |

To configure it in code, call `startTracing()` instead, still before loading the bot:

```js
const { startTracing } = require("@upbothq/discord-bot-monitoring/otel");

startTracing({
	serviceName: "my-bot",
	sampleRate: 0.1,
	// Merged over the defaults
	instrumentations: { "@opentelemetry/instrumentation-fs": { enabled: true } },
});
```

The `dns`, `net` and `fs` instrumentations are off by default: they add a lookup, a connect or a file span to almost every call. The reports of this library are never traced, so they do not show up among the traces of your bot.

When the start command can be changed, `node --import @upbothq/discord-bot-monitoring/register bot.js` works too.

Any other OpenTelemetry setup works as well: Upbot accepts standard OTLP/HTTP JSON traces at the endpoint above, with the `Authorization: Bearer <token>` header.

## License

MIT
