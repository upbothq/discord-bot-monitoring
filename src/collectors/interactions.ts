import type { Client } from "discord.js";
import type { Tracing } from "../tracing.ts";
import type { InteractionKind, InteractionPayload } from "../types.ts";
import { bucketIndex, emptyBuckets } from "./histogram.ts";

/** Discord shows "The application did not respond" when nothing acknowledged it within 3 seconds. */
export const ACK_DEADLINE_MS = 3_000;

/** Spans of interactions that never finish are closed after this delay. */
const SPAN_MAX_DURATION_MS = 60_000;

/** Distinct (type, name) pairs kept per report, the rest is grouped under OVERFLOW_NAME. */
const MAX_NAMES = 200;
const OVERFLOW_NAME = "(other)";
const MAX_NAME_LENGTH = 100;

/** Methods that acknowledge an interaction, the final ones answer it without a follow-up. */
const ACK_METHODS = ["reply", "deferReply", "update", "deferUpdate", "showModal", "respond", "sendPremiumRequired", "launchActivity"] as const;
const FINAL_ACK_METHODS = new Set<string>(["reply", "update", "showModal", "respond", "sendPremiumRequired", "launchActivity"]);
const FOLLOW_UP_METHODS = ["editReply", "followUp", "deleteReply"] as const;

// Raw Discord API values, stable across every discord.js version
const InteractionType = { ApplicationCommand: 2, MessageComponent: 3, Autocomplete: 4, ModalSubmit: 5 };
const CommandType = { ChatInput: 1, User: 2, Message: 3, PrimaryEntryPoint: 4 };
const ComponentType = { Button: 2 };

type AnyFunction = (...args: unknown[]) => unknown;

interface AnyInteraction {
	[key: string]: unknown;
	id?: string;
	type?: number;
	commandType?: number;
	commandName?: string;
	componentType?: number;
	customId?: string;
	guildId?: string | null;
	replied?: boolean;
	deferred?: boolean;
	responded?: boolean;
	options?: {
		getSubcommandGroup?: (required?: boolean) => string | null;
		getSubcommand?: (required?: boolean) => string | null;
	};
}

interface Classified {
	type: InteractionKind;
	name: string;
}

export function defaultNormalizeCustomId(customId: string): string {
	return customId
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "*")
		.replace(/[0-9a-f]{16,}/giu, "*")
		.replace(/\d{4,}/gu, "*");
}

/**
 * Measures every interaction: calls, time to acknowledge, unanswered ones and failed responses.
 * It wraps `client.emit` so it sees each interaction before any listener of the bot, and patches
 * the response methods of that interaction only.
 */
export class InteractionCollector {
	enabled = true;

	private aggregates = new Map<string, InteractionPayload>();
	private restoreEmit: (() => void) | undefined;

	constructor(
		private readonly client: Client,
		private readonly tracing: Tracing | undefined,
		private readonly normalizeCustomId: (customId: string) => string = defaultNormalizeCustomId,
		private readonly ackDeadlineMs: number = ACK_DEADLINE_MS,
	) {}

	register(): void {
		if (this.restoreEmit) {
			return;
		}

		const emitter = this.client as unknown as { emit: (event: unknown, ...args: unknown[]) => boolean };
		const original = emitter.emit;
		const track = (interaction: AnyInteraction) => this.track(interaction);

		const patched = function (this: unknown, event: unknown, ...args: unknown[]): boolean {
			const interaction = args[0] as AnyInteraction | undefined;

			if (event !== "interactionCreate" || !interaction || typeof interaction !== "object") {
				return original.call(this, event, ...args);
			}

			return track(interaction)(() => original.call(this, event, ...args));
		};

		emitter.emit = patched;
		this.restoreEmit = () => {
			// Another library may have wrapped emit after us, leave its wrapper in place then
			if (emitter.emit === patched) {
				emitter.emit = original;
			}
		};
	}

	unregister(): void {
		this.restoreEmit?.();
		this.restoreEmit = undefined;
	}

	snapshot(): InteractionPayload[] {
		const list = [...this.aggregates.values()];
		this.aggregates = new Map();

		return list;
	}

	/** Puts back metrics that could not be sent, they go out with the next report. */
	restore(list: InteractionPayload[]): void {
		for (const item of list) {
			const target = this.aggregate({ type: item.type, name: item.name });

			target.calls += item.calls;
			target.errors += item.errors;
			target.unanswered += item.unanswered;
			target.latency_sum_ms += item.latency_sum_ms;
			item.latency_buckets.forEach((count, index) => {
				target.latency_buckets[index] = (target.latency_buckets[index] ?? 0) + count;
			});

			for (const [code, count] of Object.entries(item.error_codes)) {
				target.error_codes[code] = (target.error_codes[code] ?? 0) + count;
			}
		}
	}

	private track(interaction: AnyInteraction): <T>(fn: () => T) => T {
		const classified = this.enabled ? this.classify(interaction) : undefined;

		if (!classified) {
			return (fn) => fn();
		}

		const receivedAt = performance.now();
		let acknowledged = false;
		let failed = false;
		let awaitingFollowUp = false;

		this.aggregate(classified).calls++;

		const span = this.tracing?.start(`interaction ${classified.name}`, {
			"discord.interaction.type": classified.type,
			"discord.interaction.name": classified.name,
			"discord.interaction.id": interaction.id ?? "",
			"discord.guild.id": interaction.guildId ?? "",
		});

		const endSpan = (error?: unknown) => {
			span?.end(error);
			clearTimeout(spanTimer);
		};

		const spanTimer = span ? setTimeout(() => span.end(), SPAN_MAX_DURATION_MS) : undefined;
		spanTimer?.unref?.();

		const deadline = setTimeout(() => {
			if (acknowledged || interaction.replied || interaction.deferred || interaction.responded) {
				return;
			}

			this.aggregate(classified).unanswered++;
			endSpan(new Error(`Interaction not acknowledged within ${this.ackDeadlineMs}ms`));
		}, this.ackDeadlineMs);
		deadline.unref?.();

		const onFailure = (error: unknown) => {
			const aggregate = this.aggregate(classified);
			const rawCode = (error as { code?: unknown } | undefined)?.code;
			const code = typeof rawCode === "number" || typeof rawCode === "string" ? String(rawCode) : "unknown";

			aggregate.error_codes[code] = (aggregate.error_codes[code] ?? 0) + 1;

			if (!failed) {
				failed = true;
				aggregate.errors++;
			}

			endSpan(error);
		};

		const onAcknowledge = (method: string) => {
			if (acknowledged) {
				return;
			}

			acknowledged = true;
			clearTimeout(deadline);

			const latency = performance.now() - receivedAt;
			const aggregate = this.aggregate(classified);

			aggregate.latency_sum_ms += latency;
			aggregate.latency_buckets[bucketIndex(latency)] = (aggregate.latency_buckets[bucketIndex(latency)] ?? 0) + 1;
			awaitingFollowUp = !FINAL_ACK_METHODS.has(method);
		};

		for (const method of ACK_METHODS) {
			this.wrap(interaction, method, () => onAcknowledge(method), (settled) => {
				if (FINAL_ACK_METHODS.has(method)) {
					settled.then(() => endSpan(), onFailure);
				} else {
					settled.then(undefined, onFailure);
				}
			});
		}

		for (const method of FOLLOW_UP_METHODS) {
			this.wrap(interaction, method, undefined, (settled) => {
				settled.then(() => {
					if (awaitingFollowUp) {
						awaitingFollowUp = false;
						endSpan();
					}
				}, onFailure);
			});
		}

		return span ? (fn) => span.run(fn) : (fn) => fn();
	}

	/** Wraps one method of this interaction object only, the original is called unchanged. */
	private wrap(
		interaction: AnyInteraction,
		method: string,
		beforeCall: (() => void) | undefined,
		onResult: (settled: Promise<unknown>) => void,
	): void {
		const original = interaction[method];

		if (typeof original !== "function") {
			return;
		}

		interaction[method] = function (this: unknown, ...args: unknown[]): unknown {
			beforeCall?.();

			let result: unknown;

			try {
				result = (original as AnyFunction).apply(this, args);
			} catch (error) {
				onResult(Promise.reject(error));
				throw error;
			}

			// Observe the promise without swallowing anything: the caller still gets the rejection
			onResult(Promise.resolve(result));

			return result;
		};
	}

	private classify(interaction: AnyInteraction): Classified | undefined {
		switch (interaction.type) {
			case InteractionType.ApplicationCommand:
				return { type: commandKind(interaction.commandType), name: this.commandPath(interaction) };
			case InteractionType.Autocomplete:
				return { type: "autocomplete", name: this.commandPath(interaction) };
			case InteractionType.MessageComponent:
				return {
					type: interaction.componentType === ComponentType.Button ? "button" : "select_menu",
					name: this.customIdName(interaction.customId),
				};
			case InteractionType.ModalSubmit:
				return { type: "modal", name: this.customIdName(interaction.customId) };
			default:
				return undefined;
		}
	}

	private commandPath(interaction: AnyInteraction): string {
		const parts = [interaction.commandName ?? "unknown"];

		if (interaction.commandType === CommandType.ChatInput || interaction.type === InteractionType.Autocomplete) {
			try {
				const group = interaction.options?.getSubcommandGroup?.(false);
				const subcommand = interaction.options?.getSubcommand?.(false);

				if (group) parts.push(group);
				if (subcommand) parts.push(subcommand);
			} catch {
				// Older versions throw when the command has no subcommand
			}

			return truncate(`/${parts.join(" ")}`);
		}

		return truncate(parts.join(" "));
	}

	private customIdName(customId: string | undefined): string {
		if (!customId) {
			return "unknown";
		}

		try {
			return truncate(this.normalizeCustomId(customId)) || "unknown";
		} catch {
			return truncate(defaultNormalizeCustomId(customId));
		}
	}

	private aggregate({ type, name }: Classified): InteractionPayload {
		let key = `${type}\u0000${name}`;
		let aggregate = this.aggregates.get(key);

		if (!aggregate && this.aggregates.size >= MAX_NAMES) {
			key = `${type}\u0000${OVERFLOW_NAME}`;
			aggregate = this.aggregates.get(key);
			name = OVERFLOW_NAME;
		}

		if (!aggregate) {
			aggregate = {
				type,
				name,
				calls: 0,
				errors: 0,
				unanswered: 0,
				latency_sum_ms: 0,
				latency_buckets: emptyBuckets(),
				error_codes: {},
			};
			this.aggregates.set(key, aggregate);
		}

		return aggregate;
	}
}

function commandKind(commandType: number | undefined): InteractionKind {
	switch (commandType) {
		case CommandType.User:
			return "user_context";
		case CommandType.Message:
			return "message_context";
		case CommandType.PrimaryEntryPoint:
			return "primary_entry_point";
		default:
			return "chat_input";
	}
}

function truncate(value: string): string {
	return value.length > MAX_NAME_LENGTH ? value.slice(0, MAX_NAME_LENGTH) : value;
}
