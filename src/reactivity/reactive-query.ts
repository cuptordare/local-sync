/**
 * WHAT THIS IS — reactive-query
 *
 * A reactive query is a derived value that automatically recomputes when its sources change.
 * It is similar to a reactive store, but the value is computed from other data rather than
 * being set imperatively.
 *
 * You give it 2 things:
 *   - A `compute()` function that returns the current value of the query.
 *   - A `subscribeToSources()` function that tells the query how to listen for changes in its sources.
 *
 * It then caches the computed value and only notifies subscribers when the value actually
 * changes (per the `equals` comparison).
 *
 * @example
 *   const activeTodos = createReactiveQuery({
 *     compute: () => todosStore.get().filter((t) => !t.done),
 *     subscribeToSources: (onChange) => todosStore.subscribe(onChange),
 *   });
 *
 *   render(activeTodos.getCurrentResult()); // intial render
 *   const off = activeTodos.subscribe(render); // re-render only on real changes
 *   // ...later, on teardown:
 *   off(); // unsubscribe
 *
 * @example
 *   const config = createReactiveQuery({ compute: () => readConfig() });
 *   config.getCurrentResult(); // reads the config file
 *   config.invalidate(); // force a recompute after you know the config changed
 *
 */
import type { Listener, Unsubscribe } from "../events/event-types.js";
import { deepEqual } from "../utils/deep-equal.js";

export interface ReactiveQuery<R> {
	/** Current computed result (cached + referentially stable while observed). */
	getCurrentResult(): R;
	/** Subscribe to changes. Returns an unsubscribe function. */
	subscribe(listener: Listener<R>): Unsubscribe;
	/** Manually force a re-evaluation (notifies subscribers only if the result changed). */
	invalidate(): void;
	/** Dispose of the query, cleaning up any resources. */
	dispose(): void;
}

export interface ReactiveQueryOptions<R> {
	/** Pure function that computes the current result from its data sources. */
	compute: () => R;
	/**
	 * How the query learns its sources changed. Called with an `onChange` callback
	 * when the query goes from unobserved to observed (0 to 1 subscribers), and the
	 * returned unsubscribe is called when it goes back to unobserved (1 to 0 subscribers).
	 * Omit for a static query that only updates via `invalidate()`.
	 */
	subscribeToSources?: (onChange: () => void) => Unsubscribe;
	/** Optional equality function to determine if the result changed. Defaults to `deepEqual`. */
	equals?: (a: R, b: R) => boolean;
}

export function createReactiveQuery<R>(
	options: ReactiveQueryOptions<R>,
): ReactiveQuery<R> {
	const { compute, subscribeToSources } = options;
	const equals = options.equals ?? deepEqual;

	const listeners = new Set<Listener<R>>();
	let cached: R | undefined;
	let hasCached = false;
	let sourceSubscription: Unsubscribe | undefined;

	// Recompute. Returns true if the cached reference changed.
	const evaluate = (): boolean => {
		const next = compute();
		if (hasCached && equals(cached as R, next)) {
			return false; // unchanged -- keep the stable reference, don't swap it
		}
		cached = next;
		hasCached = true;
		return true;
	};

	const notifyIfChanged = () => {
		if (!evaluate()) return; // no change, don't notify
		const snapshot = cached as R;
		for (const listener of [...listeners]) {
			listener(snapshot);
		}
	};

	const getCurrentResult = (): R => {
		// While observed, serve the cached value (kept fresh by source changes) so
		// the reference stays stable. While unobserved, refresh on read for correctness
		// (equals still preserves the reference when the value hasn't actually changed).
		if (!hasCached || listeners.size === 0) evaluate();
		return cached as R;
	};

	const subscribe = (listener: Listener<R>): Unsubscribe => {
		const wasObserved = listeners.size > 0;
		listeners.add(listener);
		if (!wasObserved) {
			evaluate(); // refresh the cache before notifying the first listener
			if (subscribeToSources && !sourceSubscription) {
				sourceSubscription = subscribeToSources(notifyIfChanged);
			}
		}
		return () => {
			if (!listeners.delete(listener)) return;
			if (listeners.size === 0 && sourceSubscription) {
				sourceSubscription();
				sourceSubscription = undefined;
			}
		};
	};

	const dispose = () => {
		listeners.clear();
		if (sourceSubscription) {
			sourceSubscription();
			sourceSubscription = undefined;
		}
	};

	return {
		getCurrentResult,
		subscribe,
		invalidate: notifyIfChanged,
		dispose,
	};
}
