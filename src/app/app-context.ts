/**
 * Internal runtime state shared by an app's methods (not part of the public API).
 * Holds the storage engine, the default merge factory, the clock, the collection
 * registry, and the app event bus. `create-local-sync-app` is the public facade over this.
 */

import type { Collection } from "../collections/collection-types.js";
import type { EventBus } from "../events/event-bus.js";
import { createEventBus } from "../events/event-bus.js";
import type { MergeFactory } from "../records/record-merge.js";
import { serverWins } from "../records/record-merge.js";
import { createMemoryAdapter } from "../storage/memory-adapter.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
import type { StorageEngine } from "../storage/storage-engine.js";
import { createStorageEngine } from "../storage/storage-engine.js";
import { now as defaultNow } from "../utils/timestamps.js";
import type { LocalSyncAppEventMap } from "./app-events.js";

export interface LocalSyncAppContext {
	readonly storage: StorageEngine;
	readonly mergeFactory: MergeFactory;
	readonly clock: () => number;
	readonly onError: (error: unknown) => void;
	/** Registered collections, keyed by name. Stored type-erased; cast on retrieval. */
	readonly collections: Map<string, Collection<object>>;
	readonly events: EventBus<LocalSyncAppEventMap>;
	disposed: boolean;
}

export interface LocalSyncAppContextOptions {
	storage?: StorageAdapter;
	merge?: MergeFactory;
	now?: () => number;
	onError?: (error: unknown) => void;
}

export function createLocalSyncAppContext(
	options: LocalSyncAppContextOptions = {},
): LocalSyncAppContext {
	const adapter = options.storage ?? createMemoryAdapter();
	return {
		storage: createStorageEngine(adapter),
		mergeFactory: options.merge ?? serverWins,
		clock: options.now ?? defaultNow,
		onError:
			options.onError ??
			((error) =>
				queueMicrotask(() => {
					throw error;
				})),
		collections: new Map(),
		events: createEventBus<LocalSyncAppEventMap>(),
		disposed: false,
	};
}
