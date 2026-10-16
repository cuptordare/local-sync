/**
 * Internal runtime state shared by an app's methods (not part of the public API).
 * Holds the storage engine, the default merge strategy, the clock, the collection
 * registry, and the app event bus. `create-local-sync-app` is the public facade over this.
 */

import type { Collection } from "../collections/collection-types.js";
import type { EventBus } from "../events/event-bus.js";
import { createEventBus } from "../events/event-bus.js";
import type { MergeFactory, MergeStrategy } from "../records/record-merge.js";
import { serverWins } from "../records/record-merge.js";
import { createIndexedDBAdapter } from "../storage/indexeddb-adapter.js";
import { createMemoryAdapter } from "../storage/memory-adapter.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
import type { StorageEngine } from "../storage/storage-engine.js";
import { createStorageEngine } from "../storage/storage-engine.js";
import type { SyncEngine, SyncStartOptions } from "../sync/sync-engine.js";
import { logBackgroundError } from "../utils/log-error.js";
import { now as defaultNow } from "../utils/timestamps.js";
import type {
	LocalSyncAppEventMap,
	LocalSyncErrorEvent,
} from "./app-events.js";

/** What kind of thing a registered name is -- a source's collection must never be handed out writable. */
export type RegistrationKind = "collection" | "keyValue" | "source";

export interface Registration {
	kind: RegistrationKind;
	collection: Collection<object>;
	/** The adapter the app syncs this collection with, if any. */
	remote: unknown;
	engine: SyncEngine<never> | undefined;
	/** How to start the engine's automatic sync; undefined = the app doesn't start it. */
	startOptions: SyncStartOptions | undefined;
	/** The wrapper object (key-value store / source) returned for this name, if any. */
	handle: unknown;
}

export interface LocalSyncAppContext {
	readonly storage: StorageEngine;
	readonly mergeFactory: MergeFactory;
	readonly clock: () => number;
	/** Report a background error: emits the app "error" event and calls the configured handler. */
	readonly report: (event: LocalSyncErrorEvent) => void;
	/** Registered collections, keyed by name. Stored type-erased; cast on retrieval. */
	readonly registry: Map<string, Registration>;
	readonly events: EventBus<LocalSyncAppEventMap>;
	disposed: boolean;
}

export interface LocalSyncAppContextOptions {
	name?: string;
	storage?: StorageAdapter;
	merge?: MergeFactory | MergeStrategy<unknown>;
	now?: () => number;
	onError?: (error: unknown, info: Omit<LocalSyncErrorEvent, "error">) => void;
}

let warnedAboutMemoryStorage = false;

function chooseStorage(options: LocalSyncAppContextOptions): StorageAdapter {
	if (options.storage !== undefined) return options.storage;
	const browserStorage = typeof indexedDB !== "undefined";
	if (options.name !== undefined && browserStorage) {
		return createIndexedDBAdapter({ databaseName: options.name });
	}
	if (browserStorage && !warnedAboutMemoryStorage) {
		warnedAboutMemoryStorage = true;
		console.warn(
			"[localsync] createLocalSyncApp() was given no `name` (or `storage`), so data is kept " +
				'in memory only and lost on reload. Pass { name: "my-app" } to persist it in IndexedDB.',
		);
	}
	return createMemoryAdapter();
}

function toMergeFactory(
	merge: MergeFactory | MergeStrategy<unknown> | undefined,
): MergeFactory {
	if (merge === undefined) return serverWins;
	if (typeof merge === "function") return merge;
	// A strategy instance (e.g. `lastWriteWins()`): the built-ins are type-agnostic, so the
	// same instance can serve every collection.
	return <T>() => merge as unknown as MergeStrategy<T>;
}

export function createLocalSyncAppContext(
	options: LocalSyncAppContextOptions = {},
): LocalSyncAppContext {
	const events = createEventBus<LocalSyncAppEventMap>();
	const report = (event: LocalSyncErrorEvent): void => {
		events.emit("error", event);
		if (options.onError !== undefined) {
			const { error, ...info } = event;
			options.onError(error, info);
		} else if (events.listenerCount("error") === 0) {
			logBackgroundError(event.error, event);
		}
	};
	return {
		storage: createStorageEngine(chooseStorage(options)),
		mergeFactory: toMergeFactory(options.merge),
		clock: options.now ?? defaultNow,
		report,
		registry: new Map(),
		events,
		disposed: false,
	};
}
