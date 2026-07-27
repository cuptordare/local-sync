/**
 * WHAT THIS IS — reactive-cache
 *
 * A simple reactive cache for storing and managing reactive queries. Use when you have
 * the same query (same key) that may be requested multiple times (from different places),
 * and you want to share the same cached result and subscriptions.
 *
 * Rule of thumb:
 *   - Use a CACHE when "give me the query for X" might be called multiple times, and you
 *     want to share the same query instance.
 *   - If you only ever have one query instance, you don't need a cache.
 *
 * @example
 *   const cache = createReactiveCache();
 *   const makeActiveTodos = () => createReactiveQuery({
 *     compute: () => todosStore.get().filter((t) => !t.done),
 *     subscribeToSources: (onChange) => todosStore.subscribe(onChange),
 *   });
 *
 *   const a = cache.get("todos|active", makeActiveTodos);
 *   const b = cache.get("todos|active", makeActiveTodos); // SAME instance as `a`
 *   // a === b -> they share computation + cached result; the factory ran only once.
 *
 *   cache.delete("todos|active"); // disposes the query and removes it from the cache
 *
 */
import type { ReactiveQuery } from "./reactive-query.js";

export interface ReactiveCache {
	/** Get the cached query for `key`, or create it using `factory` if not found. */
	get<R>(key: string, factory: () => ReactiveQuery<R>): ReactiveQuery<R>;
	has(key: string): boolean;
	/** Dispose and remove a cached query by key. Returns whether one existed. */
	delete(key: string): boolean;
	/** Dispose and remove all cached queries. */
	clear(): void;
	readonly size: number;
}

export function createReactiveCache(): ReactiveCache {
	const entries = new Map<string, ReactiveQuery<unknown>>();

	return {
		get<R>(key: string, factory: () => ReactiveQuery<R>): ReactiveQuery<R> {
			const existing = entries.get(key);
			if (existing) {
				return existing as ReactiveQuery<R>;
			}
			const created = factory();
			entries.set(key, created);
			return created;
		},

		has(key: string): boolean {
			return entries.has(key);
		},

		delete(key: string): boolean {
			const existing = entries.get(key);
			if (existing) {
				existing.dispose();
				return entries.delete(key);
			}
			return false;
		},

		clear(): void {
			for (const entry of entries.values()) {
				entry.dispose();
			}
			entries.clear();
		},

		get size(): number {
			return entries.size;
		},
	};
}
