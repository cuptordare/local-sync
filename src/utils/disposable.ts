import type { Unsubscribe } from "../events/event-types.js";

/**
 * A cleanup function. Alias of {@link Unsubscribe} -- semantically "release this resource"
 * rather than "stop listening to this event", but identical in shape.
 */
export type Disposable = Unsubscribe;

export interface DisposableBag {
	/**
	 * Register a disposable. Returns a function that disposes just this one and
	 * removes it from the bag.
	 */
	add(disposable: Disposable): Unsubscribe;
	/** Dispose all registered disposables in reverse (LIFO) order. */
	dispose(): void;
	/** The number of disposables currently registered in the bag. */
	readonly size: number;
	/** Whether `dispose()` has been called on this bag. */
	readonly disposed: boolean;
}

export function createDisposableBag(): DisposableBag {
	const items = new Set<Disposable>();
	let disposed = false;

	return {
		add(disposable: Disposable) {
			if (disposed) {
				disposable();
				return () => {};
			}
			items.add(disposable);
			return () => {
				if (items.delete(disposable)) disposable();
			};
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			// LIFO: dispose most-recently-added first.
			const ordered = [...items].reverse();
			items.clear();
			for (const disposable of ordered) disposable();
		},

		get size() {
			return items.size;
		},

		get disposed() {
			return disposed;
		},
	};
}
