/**
 * Starts tracing on import, configured from the environment (UPBOT_TOKEN, UPBOT_TRACES_SAMPLE_RATE,
 * OTEL_SERVICE_NAME). Import it first:
 *
 *   require("@upbothq/discord-bot-monitoring/register");  // first line of a CommonJS bot
 *   node --import @upbothq/discord-bot-monitoring/register bot.js
 */
import { startTracing } from "./otel.ts";

startTracing();
