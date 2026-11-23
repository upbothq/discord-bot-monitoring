# POST /api/telemetry

Reports, once per process, the status of every shard it owns and the interaction and REST metrics aggregated since the previous report. Used by the SDK from 0.1.0 (0.0.x reported each shard to `POST /api/shards`, which keeps working).

## Headers

| Header                    | Value            | Required |
| ------------------------- | ---------------- | -------- |
| `Authorization`           | `Bearer <token>` | Yes      |
| `Content-Type`            | `application/json` | Yes    |
| `x-upbot-package-version` | SDK version      | No       |

## Body

```json
{
	"instance_id": "8f0e7b52-3f4a-4d0b-9d55-1f3c0d6a2e11",
	"sdk_version": "0.1.0",
	"discordjs_version": "14.25.1",
	"runtime": "node 22.11.0",
	"shard_count": 4,
	"memory_usage": 212.4,
	"uptime": 3600000,
	"shards": [
		{ "shard_id": 0, "status": "online", "guild_count": 1204, "member_count": 98000, "ping": 42 }
	],
	"interactions": [
		{
			"type": "chat_input",
			"name": "/ticket create",
			"calls": 12,
			"errors": 1,
			"unanswered": 0,
			"latency_sum_ms": 2210.5,
			"latency_buckets": [3, 4, 3, 1, 1, 0, 0, 0, 0, 0],
			"error_codes": { "50013": 1 }
		}
	],
	"rate_limits": [
		{ "route": "/channels/:id/messages", "method": "POST", "scope": "user", "global": false, "hits": 2, "max_retry_after_ms": 1200 }
	],
	"invalid_requests": 3
}
```

- `status`: `online`, `offline`, `reconnecting` or `error`.
- `type`: `chat_input`, `user_context`, `message_context`, `primary_entry_point`, `autocomplete`, `button`, `select_menu` or `modal`.
- `latency_buckets`: interactions acknowledged within 50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000 ms, and slower.
- `invalid_requests`: 401, 403 and non-shared 429 responses from the Discord API.

Added in 0.2.0, all optional so older SDKs keep working:

- `guild_issues`: Discord API errors made while handling a command or an event, per guild: `{ guild_id, type, name, route, code, count, app_permissions }`. `route` is `"PUT /guilds/:id/members/:id/roles/:id"` or `"interaction response"`, `code` the Discord error code (`"50013"`) or the HTTP status when the body had none, `app_permissions` the permissions of the bot in that channel as a decimal bitfield. At most 500 per report.
- `release`: `{ id, source }`, the version of the bot's code: `UPBOT_RELEASE` (`"env"`), the git commit (`"git"`) or a hash of the source files outside `node_modules` (`"files"`). A new id is a deployment, the same id after a restart is not.
- `runtime_stats`: about once a minute per process. `caches` (entries per discord.js cache: guilds, channels, users, members, presences, voice_states, roles, emojis, messages), `heap_used_mb`, `heap_total_mb`, `rss_mb`, `external_mb`, `intents` (decimal bitfield), `sweepers` (configured sweeper names) and `listened_events` (client events with at least one listener).

## Response

`200 OK` with the settings the SDK applies:

```json
{ "interval_ms": 10000, "interactions": true, "rate_limits": true }
```

| Status | Description                                         |
| ------ | --------------------------------------------------- |
| `401`  | Missing or invalid token, the SDK stops reporting   |
| `422`  | Invalid body, the SDK drops this report             |
| `429`  | Too many reports, retry after `Retry-After` seconds |

# POST /api/otlp/v1/traces

Standard OTLP/HTTP JSON trace export, authenticated with the same `Authorization: Bearer <token>` header.
