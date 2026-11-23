# POST /api/shards

Reports the current status of a Discord bot shard.

## Request

### Headers

| Header          | Value              | Required |
| --------------- | ------------------ | -------- |
| `Authorization` | `Bearer <token>`   | Yes      |
| `Content-Type`  | `application/json` | Yes      |

### Body

```json
{
	"shard_id": 0,
	"shard_count": 2,
	"status": "online",
	"guild_count": 42,
	"ping": 85,
	"memory_usage": 128.4,
	"member_count": 15000,
	"uptime": 3600000
}
```

| Field          | Type     | Description                                                                   |
| -------------- | -------- | ----------------------------------------------------------------------------- |
| `shard_id`     | `number` | The ID of the shard being reported                                            |
| `shard_count`  | `number` | Total number of shards (used to detect removed shards)                        |
| `status`       | `string` | Current shard status: `"online"`, `"offline"`, `"reconnecting"`, or `"error"` |
| `guild_count`  | `number` | Number of guilds the shard is serving                                         |
| `ping`         | `number` | WebSocket heartbeat latency in milliseconds                                   |
| `memory_usage` | `number` | Process memory usage in megabytes (RSS)                                       |
| `member_count` | `number` | Total number of members across all guilds                                     |
| `uptime`       | `number` | Bot process uptime in milliseconds                                            |

## Response

### Success

**Status:** `200 OK` or `204 No Content`

### Error

| Status | Description                               |
| ------ | ----------------------------------------- |
| `401`  | Missing or invalid `Authorization` header |
| `422`  | Invalid request body                      |
| `500`  | Internal server error                     |

## Example

```bash
curl -X POST https://your-api-endpoint.com/api/shards \
  -H "Authorization: Bearer your-api-token" \
  -H "Content-Type: application/json" \
  -d '{
    "shard_id": 0,
    "shard_count": 2,
    "status": "online",
    "guild_count": 42,
    "ping": 85,
    "memory_usage": 128.4,
    "member_count": 15000,
    "uptime": 3600000
  }'
```
