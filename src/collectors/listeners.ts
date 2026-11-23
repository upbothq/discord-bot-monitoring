type Handler = (...args: never[]) => void;

interface Emitter {
	on(event: string, handler: Handler): unknown;
	off?(event: string, handler: Handler): unknown;
	removeListener?(event: string, handler: Handler): unknown;
}

/** Keeps track of the listeners added to an emitter so they can all be removed on destroy. */
export class Listeners {
	private readonly added: [string, Handler][] = [];

	constructor(private readonly emitter: Emitter | undefined) {}

	on<Args extends unknown[]>(event: string, handler: (...args: Args) => void): void {
		if (!this.emitter || typeof this.emitter.on !== "function") {
			return;
		}

		const listener = handler as unknown as Handler;

		this.emitter.on(event, listener);
		this.added.push([event, listener]);
	}

	removeAll(): void {
		for (const [event, handler] of this.added) {
			if (typeof this.emitter?.off === "function") {
				this.emitter.off(event, handler);
			} else {
				this.emitter?.removeListener?.(event, handler);
			}
		}

		this.added.length = 0;
	}
}
