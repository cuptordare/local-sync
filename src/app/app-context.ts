/**
 * Internal runtime state shared by an app's methods (not part of the public API).
 * Holds the storage adapter, this tab's clock and writer id, the collection registry, and
 * the app event bus. `create-local-sync-app` is the public facade over this.
 */

import type { Collection } from "../collections/collection-types.js";
import type { HybridClock } from "../crdt/hlc.js";
import { createHybridClock } from "../crdt/hlc.js";
import type { EventBus } from "../events/event-bus.js";
import { createEventBus } from "../events/event-bus.js";
import { loadWriterId } from "../storage/device-id.js";
import { createIndexedDBAdapter } from "../storage/indexeddb-adapter.js";
import { createMemoryAdapter } from "../storage/memory-adapter.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
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
	readonly storage: StorageAdapter;
	/** Wall clock (epoch ms), for status timestamps. */
	readonly now: () => number;
	/** This tab's hybrid clock, which every write is stamped with. */
	readonly clock: HybridClock;
	/** The `device` this tab writes as (loaded once, retried if loading failed). */
	readonly writerId: () => Promise<string>;
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
	const storage = chooseStorage(options);
	const now = options.now ?? defaultNow;
	let writer: Promise<string> | undefined;
	return {
		storage,
		now,
		clock: createHybridClock(now),
		writerId() {
			if (writer === undefined) {
				const loading = loadWriterId(storage);
				writer = loading;
				loading.catch(() => {
					if (writer === loading) writer = undefined; // retried by the next caller
				});
			}
			return writer;
		},
		report,
		registry: new Map(),
		events,
		disposed: false,
	};
}
