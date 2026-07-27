/**
 * Is the one call most consumers make. It owns the storage engine and registry
 * of collections, applies an app-wide default merge strategy, and hands back a
 * small handle.
 */

import type { Collection } from "../collections/collection-types.js";
import { createCollection } from "../collections/create-collection.js";
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { MergeFactory, MergeStrategy } from "../records/record-merge.js";
import type { Validator } from "../records/record-validation.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
import { createLocalSyncAppContext } from "./app-context.js";
import type { LocalSyncAppEventMap } from "./app-events.js";

/** Per-collection overrides passed to `app.collection(name, config)`. */
export interface CollectionConfig<T extends object> {
	/** Write-time validation for this collection. */
	validator: Validator<T>;
	/** Conflict-resolution strategy for this collection (overrides the app default). */
	merge?: MergeStrategy<T>;
}

export interface CreateLocalSyncAppOptions {
	/** Persistence backend. Defaults to an in-memory adapter. */
	storage?: StorageAdapter;
	/** App-wide default merge strategy builder. Defaults to `serverWins`. */
	merge?: MergeFactory;
	/** Injectable clock (epoch ms). Defaults to the shared `now()`. */
	now?: () => number;
	/** Handler for background persistence errors. Defaults to an async throw. */
	onError?: (error: unknown) => void;
}

export interface LocalSyncApp {
	/** Create a collection, or return the existing one with this name. */
	collection<T extends object>(
		name: string,
		config?: CollectionConfig<T>,
	): Collection<T>;
	/** Whether a collection with this name has been registered. */
	hasCollection(name: string): boolean;
	/** Names of all registered collections. */
	readonly collections: readonly string[];
	/** Resolve once all currently-registered collections have hydrated from storage. */
	ready(): Promise<void>;
	/** Subscribe to app events. Returns an unsubscribe function. */
	on<K extends keyof LocalSyncAppEventMap>(
		type: K,
		listener: Listener<LocalSyncAppEventMap[K]>,
	): Unsubscribe;
	/** Dispose all collections and close storage. The app is unusable afterward. */
	close(): Promise<void>;
}

export function createLocalSyncApp(
	options: CreateLocalSyncAppOptions = {},
): LocalSyncApp {
	const ctx = createLocalSyncAppContext(options);

	return {
		collection<T extends object>(
			name: string,
			config?: CollectionConfig<T>,
		): Collection<T> {
			if (ctx.disposed)
				throw new Error("Cannot create a collection on a closed app");
			const existing = ctx.collections.get(name);
			if (existing !== undefined) return existing as unknown as Collection<T>;

			const collection = createCollection<T>({
				name,
				storage: ctx.storage,
				...(config?.validator !== undefined
					? { validator: config.validator }
					: {}),
				merge: config?.merge ?? ctx.mergeFactory<T>(),
				now: ctx.clock,
				onError: ctx.onError,
			});
			ctx.collections.set(name, collection as unknown as Collection<object>);
			ctx.events.emit("collection:created", { name });
			return collection;
		},

		hasCollection: (name: string) => ctx.collections.has(name),

		get collections() {
			return [...ctx.collections.keys()];
		},

		async ready() {
			await Promise.all([...ctx.collections.values()].map((c) => c.ready));
		},

		on<K extends keyof LocalSyncAppEventMap>(
			type: K,
			listener: Listener<LocalSyncAppEventMap[K]>,
		): Unsubscribe {
			return ctx.events.on(type, listener);
		},

		async close() {
			if (ctx.disposed) return;
			ctx.disposed = true;
			for (const collection of ctx.collections.values()) collection.dispose();
			ctx.collections.clear();
			await ctx.storage.close();
			ctx.events.emit("disposed");
		},
	};
}
