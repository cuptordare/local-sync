/**
 * The "simple named values" recipe: a thin, value-oriented view over a Collection.
 *
 * You read and write plain values by key -- no envelopes, no insert-vs-replace, no "does it
 * exist yet?" bookkeeping. Missing keys can return a default value that is never stored or
 * pushed until you actually `set` it. All behavior (validation, persistence, sync, conflict
 * handling) lives in the underlying Collection / SyncEngine; this file only adapts the shape.
 *
 * @example
 *   const settings = app.keyValue<Settings>("settings", {
 *     remote: myAdapter,
 *     defaultValue: () => ({ theme: "light" }),
 *   });
 *   await app.ready();
 *   settings.get("alice");                                   // { theme: "light" } until set
 *   settings.update("alice", (s) => ({ ...s, theme: "dark" })); // saved + pushed (debounced)
 *   const off = settings.watch("alice", render);             // fires now, then on change
 */
import type { Collection } from "../collections/collection-types.js";
import type { Unsubscribe } from "../events/event-types.js";
import type { SyncEngine } from "../sync/sync-engine.js";
import { deepEqual } from "../utils/deep-equal.js";
import { deepFreeze } from "../utils/freeze.js";

export interface WatchOptions {
	/** Call the listener right away with the current value. Default true. */
	immediate?: boolean;
}

export interface KeyValueStore<T extends object, V = T | undefined> {
	readonly name: string;
	/** Resolves once stored values have loaded. */
	readonly ready: Promise<void>;
	/** The value for `key`, or the default value (or undefined) if it has never been set. Frozen. */
	get(key: string): V;
	/** Whether `key` has a stored value (a default value doesn't count). */
	has(key: string): boolean;
	// set/update/delete throw until stored values have loaded (`await app.ready()` first).

	/** Store a value (insert or replace). A no-op if it's unchanged. Pushed automatically if synced. */
	set(key: string, value: T): void;
	/** Store the result of `fn(current)`. */
	update(key: string, fn: (current: V) => T): void;
	/** Remove a key (`get` then returns the default again). */
	delete(key: string): void;
	/** Keys that have stored values. */
	keys(): string[];
	/** `[key, value]` pairs for every stored value. */
	entries(): Array<[string, T]>;
	/** Observe one key. Only called when the value itself changes (not on sync bookkeeping). */
	watch(
		key: string,
		listener: (value: V) => void,
		options?: WatchOptions,
	): Unsubscribe;
	/** Observe every stored value. */
	watchAll(
		listener: (values: ReadonlyMap<string, T>) => void,
		options?: WatchOptions,
	): Unsubscribe;
	/** The underlying collection (advanced: envelopes, metadata, pending changes). */
	readonly collection: Collection<T>;
	/** The sync engine, if this store has a `remote` (advanced: manual pull/push, events). */
	readonly engine: SyncEngine | undefined;
}

export function createKeyValueStore<T extends object, V = T | undefined>(
	collection: Collection<T>,
	engine: SyncEngine | undefined,
	defaultValue: ((key: string) => T) | undefined,
): KeyValueStore<T, V> {
	// Cached so repeated reads of a missing key return the same (frozen) object.
	const defaults = new Map<string, T>();
	const fallback = (key: string): V => {
		if (defaultValue === undefined) return undefined as V;
		let value = defaults.get(key);
		if (value === undefined) {
			value = deepFreeze(structuredClone(defaultValue(key)));
			defaults.set(key, value);
		}
		return value as unknown as V;
	};

	const get = (key: string): V =>
		(collection.peek(key)?.data as V | undefined) ?? fallback(key);

	const entries = (): Array<[string, T]> =>
		collection
			.query()
			.getCurrentResult()
			.map((record) => [record.id, record.data]);

	return {
		name: collection.name,
		get ready() {
			return collection.ready;
		},
		get,
		has: (key) => collection.peek(key) !== undefined,
		set: (key, value) => collection.upsert(key, value),
		update(key, fn) {
			if (!collection.hydrated) {
				throw new Error(
					`Cannot update "${key}" in "${collection.name}" before stored values have loaded ` +
						"-- await app.ready() first (otherwise the update would start from the default value).",
				);
			}
			collection.upsert(key, fn(get(key)));
		},
		delete: (key) => collection.delete(key),
		keys: () => entries().map(([key]) => key),
		entries,
		watch(key, listener, options = {}) {
			let last = get(key);
			const unsubscribe = collection.get(key).subscribe(() => {
				const next = get(key);
				if (deepEqual(next, last)) return; // e.g. only sync metadata changed
				last = next;
				listener(next);
			});
			if (options.immediate ?? true) listener(last);
			return unsubscribe;
		},
		watchAll(listener, options = {}) {
			const snapshot = () => new Map(entries());
			let last = snapshot();
			const unsubscribe = collection.subscribe(({ changes }) => {
				// Compare only the changed keys (e.g. an ack touches metadata, not values).
				const valueChanged = changes.some(
					(c) => !deepEqual(collection.peek(c.id)?.data, last.get(c.id)),
				);
				if (!valueChanged) return;
				last = snapshot();
				listener(last);
			});
			if (options.immediate ?? true) listener(last);
			return unsubscribe;
		},
		collection,
		engine,
	};
}
