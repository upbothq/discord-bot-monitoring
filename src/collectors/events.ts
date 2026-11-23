import { EventEmitter } from "node:events";
import type { Client } from "discord.js";
import { discordContext } from "../context.ts";
import type { Tracing } from "../tracing.ts";

/**
 * Events left out of the traces: interactions have their own spans, the others are internal,
 * handled by this library, or too frequent to be worth a trace each.
 */
export const UNTRACED_EVENTS: ReadonlySet<string> = new Set([
	"interactionCreate",
	"raw",
	"debug",
	"warn",
	"error",
	"cacheSweep",
	"invalidated",
	"ready",
	"clientReady",
	"shardReady",
	"shardResume",
	"shardReconnecting",
	"shardDisconnect",
	"shardError",
	"presenceUpdate",
	"typingStart",
	"guildMembersChunk",
	"voiceServerUpdate",
]);

type Listener = (...args: unknown[]) => unknown;

interface Emitter {
	emit: (event: unknown, ...args: unknown[]) => boolean;
	rawListeners: (event: string) => Listener[];
}

function isPromise(value: unknown): value is PromiseLike<unknown> {
	return typeof (value as PromiseLike<unknown> | null)?.then === "function";
}

function guildId(payload: unknown): string {
	const value = payload as { guildId?: unknown; guild?: { id?: unknown } } | null | undefined;
	const id = value?.guildId ?? value?.guild?.id;

	return typeof id === "string" ? id : "";
}

/**
 * Opens a root span per Discord event the bot listens to (messageCreate, guildMemberAdd…), so
 * the database and HTTP calls of its listeners land in one trace per event. The span lasts until
 * the promises returned by async listeners settle.
 */
export class EventTracer {
	private restoreEmit: (() => void) | undefined;

	constructor(
		private readonly client: Client,
		/** Without tracing, listeners still run in their guild context, for the REST errors. */
		private readonly tracing: Tracing | undefined,
		private readonly ignored: ReadonlySet<string> = UNTRACED_EVENTS,
	) {}

	register(): void {
		if (this.restoreEmit) {
			return;
		}

		const emitter = this.client as unknown as Emitter;
		const original = emitter.emit;
		// Listeners are called here only when emit is the plain Node one (discord.js v14), any
		// other emit keeps its own dispatch and the span ends when the listeners return
		const dispatchHere = original === EventEmitter.prototype.emit;
		const { tracing, ignored } = this;

		const patched = function (this: unknown, event: unknown, ...args: unknown[]): boolean {
			if (typeof event !== "string" || ignored.has(event) || emitter.rawListeners(event).length === 0) {
				return original.call(this, event, ...args);
			}

			const guild = guildId(args[0]);
			const context = { guildId: guild === "" ? null : guild, type: "event", name: event, appPermissions: null };
			const span = tracing?.start(`event ${event}`, {
				"discord.event.name": event,
				"discord.guild.id": guild,
			});

			if (!span) {
				return discordContext.run(context, () => original.call(this, event, ...args));
			}

			const run = <T>(fn: () => T): T => discordContext.run(context, () => span.run(fn));

			if (!dispatchHere) {
				try {
					return run(() => original.call(this, event, ...args));
				} catch (error) {
					span.end(error);
					throw error;
				} finally {
					span.end();
				}
			}

			// Same order and error behaviour as EventEmitter#emit, on a copy of the listeners
			const listeners = [...emitter.rawListeners(event)];
			const pending: PromiseLike<unknown>[] = [];

			try {
				run(() => {
					for (const listener of listeners) {
						const result = listener.apply(this, args);

						if (isPromise(result)) {
							pending.push(result);
						}
					}
				});
			} catch (error) {
				span.end(error);
				throw error;
			}

			if (pending.length === 0) {
				span.end();

				return true;
			}

			let remaining = pending.length;
			let failure: unknown;
			const settle = () => {
				remaining -= 1;

				if (remaining === 0) {
					span.end(failure);
				}
			};

			for (const promise of pending) {
				// The rethrow keeps an unhandled rejection unhandled, as it was without the span
				void promise.then(settle, (error: unknown) => {
					failure ??= error;
					settle();
					throw error;
				});
			}

			return true;
		};

		emitter.emit = patched;
		this.restoreEmit = () => {
			if (emitter.emit === patched) {
				emitter.emit = original;
			}
		};
	}

	unregister(): void {
		this.restoreEmit?.();
		this.restoreEmit = undefined;
	}
}
