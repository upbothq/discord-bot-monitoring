let debugEnabled = false;

export function enableLogging(): void {
	debugEnabled = true;
}

type Logger = Record<"error" | "warn" | "info" | "debug", (...args: unknown[]) => void>;

export const logger: Logger = {
	error: (...args: unknown[]): void => { console.error("[discord-bot-monitoring]", ...args); },
	warn:  (...args: unknown[]): void => { console.warn( "[discord-bot-monitoring]", ...args); },
	info:  (...args: unknown[]): void => { if (debugEnabled) console.log(  "[discord-bot-monitoring]", ...args); },
	debug: (...args: unknown[]): void => { if (debugEnabled) console.debug("[discord-bot-monitoring]", ...args); },
};
