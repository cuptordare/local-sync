/**
 * WHAT THIS IS — reactive-store
 *
 * The lowest-level reactive primitive in the library. It holds a value and notifies
 * listeners when that value changes.
 *
 * Rule of thumb:
 *   - Use a STORE when the value is something you imperatively set (e.g. status, flags, etc.).
 *   - Use a QUERY when the value is DERIVED from other data and should recompute automatically.
 *
 * @example
 *   const status = createReactiveStore<"idle" | "loading" | "error">("idle");
 *
 *   console.log(status.get()); // "idle"
 *   const off = status.subscribe((next) => console.log("status changed to", next));
 *
 *   status.set("loading"); // logs "status changed to loading"
 *   status.set("loading"); // no log, value didn't change
 *   off(); // unsubscribe
 */
import type { Listener, Unsubscribe } from "../events/event-types.js";

/**
 * It does exactly one thing -- hold a current value and notify listeners when that
 * value changes (per the `equals` comparison).
 *
 * Subscribing does NOT immediately call the listener with the current value.
 */
export interface ReactiveStore<T> {
	/** Current value. */
	get(): T;
	/** Replace the value; notifies listeners only if it changed per `equals` comparison. */
	set(next: T): void;
	/** Update the value using a function; notifies listeners only if it changed per `equals` comparison. */
	update(updater: (current: T) => T): void;
	/** Subscribe to changes. Returns an unsubscribe function. */
	subscribe(listener: Listener<T>): Unsubscribe;
	/** Number of active listeners. */
	readonly listenerCount: number;
}

export interface ReactiveStoreOptions<T> {
	/** Optional equality function to determine if the value changed. Defaults to `Object.is`. */
	equals?: (a: T, b: T) => boolean;
}

export function createReactiveStore<T>(
	initial: T,
	options: ReactiveStoreOptions<T> = {},
): ReactiveStore<T> {
	const equals = options.equals ?? Object.is;
	let value = initial;
	const listeners = new Set<Listener<T>>();

	const set = (next: T) => {
		if (equals(value, next)) return;
		value = next;
		// Snapshot the listeners to avoid issues if a listener unsubscribes during notification.
		for (const listener of [...listeners]) {
			listener(value);
		}
	};

	return {
		get: () => value,
		set,
		update: (updater) => set(updater(value)),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		get listenerCount() {
			return listeners.size;
		},
	};
}
