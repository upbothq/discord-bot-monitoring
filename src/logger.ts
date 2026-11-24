const PREFIX = "[discord-bot-monitoring]";

let debugEnabled = false;

export function enableLogging(): void {
	debugEnabled = true;
}

type Logger = Record<"error" | "warn" | "info" | "debug", (...args: unknown[]) => void>;

export const logger: Logger = {
	error: (...args) => console.error(PREFIX, ...args),
	warn: (...args) => console.warn(PREFIX, ...args),
	info: (...args) => {
		if (debugEnabled) console.log(PREFIX, ...args);
	},
	debug: (...args) => {
		if (debugEnabled) console.debug(PREFIX, ...args);
	},
};
