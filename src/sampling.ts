/** Trace sampling the dashboard sends back with each report. */
export interface TraceSampling {
	/** Share of the traces to keep, from 0 to 1. */
	rate: number;
	/** Keep every failed trace, whatever the rate. */
	errorsOnly: boolean;
}

/**
 * Shared between the monitor, which receives the settings, and the tracing SDK, which applies them.
 * Kept on globalThis because they live in separate entries, each with its own module scope.
 */
const SAMPLING_KEY = Symbol.for("@upbothq/discord-bot-monitoring/sampling");

type GlobalWithSampling = typeof globalThis & { [SAMPLING_KEY]?: TraceSampling };

export function remoteSampling(): TraceSampling | undefined {
	return (globalThis as GlobalWithSampling)[SAMPLING_KEY];
}

export function setRemoteSampling(sampling: TraceSampling | undefined): void {
	(globalThis as GlobalWithSampling)[SAMPLING_KEY] = sampling;
}
