/**
 * Is the one call most consumers make. It owns storage, the registry of collections, and --
 * for collections given a `remote` -- their sync engines, so an app gets one place to sync,
 * one status to show, and one stream of errors to watch.
 *
 * Two recipes cover most apps:
 *   - `app.keyValue(name, { remote })` -- simple named values you read and write.
 *   - `app.source(name, { fetchPage })` -- a read-only list pulled from an outside service.
 * `app.collection(name)` is the general-purpose (lower-level) record collection both build on.
 */

import type {
	Collection,
	CollectionErrorInfo,
} from "../collections/collection-types.js";
import { createCollection } from "../collections/create-collection.js";
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { NetworkStatus } from "../network/network-status.js";
import { createNetworkStatus } from "../network/network-status.js";
import type { Validator } from "../records/record-validation.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
import { createSyncEngine } from "../sync/create-sync-engine.js";
import type { SyncAdapter } from "../sync/sync-adapter.js";
import type { SyncEngine } from "../sync/sync-engine.js";
import type { RetryOptions } from "../sync/sync-retries.js";
import type {
	LocalSyncAppContext,
	Registration,
	RegistrationKind,
} from "./app-context.js";
import { createLocalSyncAppContext } from "./app-context.js";
import type {
	LocalSyncAppEventMap,
	LocalSyncErrorEvent,
} from "./app-events.js";
import type { AppMultiTab, MultiTabOptions } from "./app-multi-tab.js";
import { createAppMultiTab } from "./app-multi-tab.js";
import type { AppSyncStatus } from "./app-status.js";
import { createAppSyncStatus } from "./app-status.js";
import type { KeyValueStore } from "./key-value-store.js";
import { createKeyValueStore } from "./key-value-store.js";
import type { Source, SourceAdapterOptions } from "./source.js";
import {
	createSource,
	createSourceEngine,
	toReadonlyCollection,
} from "./source.js";

/** How the app runs sync for a collection that has a `remote`. */
export interface ManagedSyncOptions {
	/**
	 * Also sync on this interval, to pick up other people's changes while the page stays open.
	 * Default: no polling -- sync happens on start, shortly after local changes, on reconnect,
	 * and when the user comes back to the page (see `syncWhenVisible`). Minutes, not seconds,
	 * is usually plenty.
	 */
	syncIntervalMs?: number;
	/** Push local changes this long after the last edit. Default 500ms. */
	pushDebounceMs?: number;
	/** Start syncing automatically. Default true; false = drive `app.engine(name)` yourself. */
	autoSync?: boolean;
	/** Retry/backoff for failed pulls/pushes. */
	retry?: RetryOptions;
}

/** Per-collection settings for `app.collection(name, config)`. */
export interface CollectionConfig<T extends object> extends ManagedSyncOptions {
	/** Validation for local writes (which throw), and for values from elsewhere (hidden if invalid). */
	validator?: Validator<T>;
	/** Sync this collection through this adapter; the app creates and runs the engine. */
	remote?: SyncAdapter<T>;
}

export interface KeyValueOptions<T extends object> extends ManagedSyncOptions {
	/** Sync these values through this adapter (e.g. `createBlobSyncAdapter(...)`). */
	remote?: SyncAdapter<T>;
	/** Validation for local writes (which throw), and for values from elsewhere (hidden if invalid). */
	validator?: Validator<T>;
}

export interface SourceOptions<T extends object, Filter, Cursor>
	extends SourceAdapterOptions<T, Filter, Cursor> {
	/** Initial filter passed to `fetchPage`. */
	filter?: Filter;
	/** Refresh on this interval. Default: on start and on reconnect only. */
	refreshIntervalMs?: number;
	/** Validation for fetched items; invalid items are skipped and reported as app "error"s. */
	validator?: Validator<T>;
	/** Retry/backoff for failed fetches. */
	retry?: RetryOptions;
	/** Start fetching automatically. Default true. */
	autoSync?: boolean;
}

export interface CreateLocalSyncAppOptions {
	/**
	 * Your app's name. In a browser it's the IndexedDB database the data is saved in (unless
	 * you pass `storage`). Without a name or storage, data lives in memory and is lost on reload.
	 */
	name?: string;
	/** Persistence backend. Defaults to IndexedDB when `name` is set in a browser, else memory. */
	storage?: StorageAdapter;
	/** Injectable clock (epoch ms). Defaults to the shared `now()`. */
	now?: () => number;
	/**
	 * Handler for background errors. Default: emit app `"error"` events, logged with
	 * `console.error` if nothing listens.
	 */
	onError?: (error: unknown, info: Omit<LocalSyncErrorEvent, "error">) => void;
	/** Connectivity source for app-managed sync. Defaults to `createNetworkStatus()`. */
	network?: NetworkStatus;
	/**
	 * Keep several open tabs of this app consistent: edits show up in every tab, and only one
	 * tab syncs automatically. On by default when the app persists to IndexedDB via `name`
	 * (tabs share that database); pass `true` or options to enable it for your own shared
	 * `storage`, or `false` to turn it off. The syncing tab is elected with the Web Locks API;
	 * where Web Locks or BroadcastChannel is missing, multi-tab is off. Options inject the
	 * `channel` and `locks` (e.g. in-memory fakes for tests).
	 */
	multiTab?: boolean | MultiTabOptions;
	/**
	 * Sync again when the user comes back to the page (it becomes visible), so they see others'
	 * changes right away instead of waiting for the next `syncIntervalMs`. Applies to collections
	 * the app syncs automatically; ones that synced in the last few seconds are skipped.
	 * Default true (browser only).
	 */
	syncWhenVisible?: boolean;
}

export interface LocalSyncApp {
	/** Create a collection, or return the existing one with this name. */
	collection<T extends object>(
		name: string,
		config?: CollectionConfig<T>,
	): Collection<T>;
	/** A store of simple named values, optionally synced. Returns the existing one if already created. */
	keyValue<T extends object>(
		name: string,
		options: KeyValueOptions<T> & { defaultValue: (key: string) => T },
	): KeyValueStore<T, T>;
	keyValue<T extends object>(
		name: string,
		options?: KeyValueOptions<T>,
	): KeyValueStore<T>;
	/** A read-only, locally cached list pulled from an outside service. */
	source<T extends object, Filter = unknown, Cursor = unknown>(
		name: string,
		options: SourceOptions<T, Filter, Cursor>,
	): Source<T, Filter>;
	/** The sync engine the app runs for this name, if it has a remote (advanced). */
	engine(name: string): SyncEngine | undefined;
	/** Whether a collection with this name has been registered. */
	hasCollection(name: string): boolean;
	/** Names of all registered collections. */
	readonly collections: readonly string[];
	/** Resolve once all currently-registered collections have loaded from storage (retrying any that failed). */
	ready(): Promise<void>;
	/**
	 * Sync every app-managed remote now (push, then pull). Rejects if any failed (after all
	 * have finished); failures are also reported as app "error" events.
	 */
	sync(): Promise<void>;
	/** One status across every app-managed remote (for a "Saving / Offline / Error" badge). */
	readonly status: AppSyncStatus;
	/** Subscribe to app events. Returns an unsubscribe function. */
	on<K extends keyof LocalSyncAppEventMap>(
		type: K,
		listener: Listener<LocalSyncAppEventMap[K]>,
	): Unsubscribe;
	/** Push pending changes (best effort, briefly), stop syncing, and close storage. */
	close(): Promise<void>;
}

/** How long `close()` waits for pending pushes before giving up on them (they stay saved locally). */
const CLOSE_FLUSH_TIMEOUT_MS = 2000;
/** Coming back to the page doesn't re-sync a collection that synced this recently. */
const VISIBLE_SYNC_MIN_GAP_MS = 5000;

export function createLocalSyncApp(
	options: CreateLocalSyncAppOptions = {},
): LocalSyncApp {
	const ctx: LocalSyncAppContext = createLocalSyncAppContext(options);
	let network = options.network;
	const ownsNetwork = network === undefined;
	const getNetwork = (): NetworkStatus => {
		network ??= createNetworkStatus();
		return network;
	};
	const status = createAppSyncStatus(() => network);

	// When tabs coordinate, the leader syncs its collections; a follower syncs only those the
	// leader doesn't have (e.g. used only on this tab's page). Unknown until the leader says.
	let leaderCollections: ReadonlySet<string> | undefined;
	const followerSynced = new Set<string>();

	const autoSynced = (): string[] =>
		[...ctx.registry].flatMap(([name, r]) =>
			r.engine !== undefined && r.startOptions !== undefined ? [name] : [],
		);

	/** Start a registration's automatic sync, if this tab is the one that should run it. */
	const startIfAllowed = (name: string, registration: Registration): void => {
		if (registration.engine === undefined) return;
		if (registration.startOptions === undefined) return;
		if (multiTab !== undefined && !multiTab.isLeader()) {
			if (leaderCollections === undefined || leaderCollections.has(name))
				return;
			if (followerSynced.has(name)) return;
			followerSynced.add(name);
		}
		registration.engine.start(registration.startOptions);
		if (multiTab?.isLeader()) multiTab.publishCollections(autoSynced());
	};

	const multiTab = ((): AppMultiTab | undefined => {
		const setting = options.multiTab;
		if (setting === false) return undefined;
		const multiTabOptions = typeof setting === "object" ? setting : {};
		// Tabs share storage when the app picked IndexedDB itself; for custom storage, only
		// when asked. (Never in Node: no IndexedDB, so no shared storage to coordinate.)
		const sharesStorage =
			options.storage === undefined &&
			options.name !== undefined &&
			typeof indexedDB !== "undefined";
		if (setting === undefined && !sharesStorage) return undefined;
		return createAppMultiTab(options.name ?? "app", multiTabOptions, {
			onEntries: (collection, changes, removed) =>
				ctx.registry.get(collection)?.collection.mergeFromTab(changes, removed),
			onLeaderStatus: (state) => status.setOverride(state),
			onBecameLeader() {
				followerSynced.clear();
				for (const [name, registration] of ctx.registry) {
					startIfAllowed(name, registration);
				}
				multiTab?.publishCollections(autoSynced());
			},
			onFilter: (collection, filter) =>
				ctx.registry.get(collection)?.engine?.setFilter(filter as never),
			onLeaderCollections(names) {
				leaderCollections = new Set(names);
				for (const [name, registration] of ctx.registry) {
					if (leaderCollections.has(name) && followerSynced.delete(name)) {
						registration.engine?.stop(); // the leader runs it now
					} else {
						startIfAllowed(name, registration);
					}
				}
			},
		});
	})();
	if (multiTab !== undefined) {
		multiTab.publishStatus(status.local.get());
		status.local.subscribe((state) => multiTab.publishStatus(state));
	}

	// Coming back to the page: catch up now rather than at the next interval. Done here (not
	// per engine) so it works in whichever tab the user returns to -- with multi-tab, that's
	// often not the tab running automatic sync; a manual sync from any tab is safe.
	const stopVisibleSync = ((): Unsubscribe | undefined => {
		if (options.syncWhenVisible === false || typeof document === "undefined") {
			return undefined;
		}
		const onVisibilityChange = (): void => {
			if (document.visibilityState !== "visible" || ctx.disposed) return;
			const now = ctx.now();
			for (const registration of ctx.registry.values()) {
				const { engine } = registration;
				if (engine === undefined || registration.startOptions === undefined)
					continue;
				const last = engine.getState().lastSyncedAt;
				if (last !== undefined && now - last < VISIBLE_SYNC_MIN_GAP_MS)
					continue;
				void engine.sync().catch(() => {}); // failures reach app "error" + status
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	})();

	const assertOpen = (): void => {
		if (ctx.disposed) throw new Error("This app has been closed");
	};

	const register = <T extends object>(
		kind: RegistrationKind,
		name: string,
		config: CollectionConfig<T>,
		/** The engine for a collection that doesn't sync through a `remote` (a source). */
		makeEngine?: (collection: Collection<T>) => SyncEngine<never>,
	): Registration => {
		const collection = createCollection<T>({
			name,
			storage: ctx.storage,
			...(config.validator !== undefined
				? { validator: config.validator }
				: {}),
			clock: ctx.clock,
			writerId: ctx.writerId,
			onError: (error: unknown, info: CollectionErrorInfo) =>
				ctx.report({ ...info, error }),
			...(multiTab !== undefined
				? {
						onPersist: (changes, removed) =>
							multiTab.announceEntries(name, changes, removed),
					}
				: {}),
		});

		const engine =
			makeEngine?.(collection) ??
			(config.remote === undefined
				? undefined
				: (createSyncEngine<T>({
						collection,
						adapter: config.remote,
						network: getNetwork(),
						now: ctx.now,
						...(config.retry !== undefined ? { retry: config.retry } : {}),
					}) as SyncEngine<never>));
		if (engine !== undefined) {
			engine.on("sync:error", ({ error }) =>
				ctx.report({ source: "sync", collection: name, error }),
			);
			status.track(name, engine);
		}

		const registration: Registration = {
			kind,
			collection: collection as unknown as Collection<object>,
			remote: config.remote,
			engine,
			handle: undefined,
			startOptions:
				engine !== undefined && (config.autoSync ?? true)
					? {
							syncOnStart: true,
							pushOnChange:
								config.pushDebounceMs === undefined
									? true
									: { debounceMs: config.pushDebounceMs },
							...(config.syncIntervalMs !== undefined
								? { intervalMs: config.syncIntervalMs }
								: {}),
						}
					: undefined,
		};
		ctx.registry.set(name, registration);
		ctx.events.emit("collection:created", { name });
		startIfAllowed(name, registration);
		return registration;
	};

	/** Look up an existing registration, refusing a mismatched kind or a different remote. */
	const existing = (
		kind: RegistrationKind,
		name: string,
		remote: unknown,
		remoteGiven: boolean,
	): Registration | undefined => {
		const found = ctx.registry.get(name);
		if (found === undefined) return undefined;
		if (found.kind !== kind) {
			throw new Error(
				`"${name}" is already registered as a ${found.kind}; it can't also be used as a ${kind}`,
			);
		}
		if (remoteGiven && found.remote !== remote) {
			throw new Error(
				`"${name}" is already registered with a different remote adapter`,
			);
		}
		return found;
	};

	const app: LocalSyncApp = {
		collection<T extends object>(
			name: string,
			config: CollectionConfig<T> = {},
		): Collection<T> {
			assertOpen();
			const found = existing(
				"collection",
				name,
				config.remote,
				config.remote !== undefined,
			);
			const registration = found ?? register("collection", name, config);
			return registration.collection as unknown as Collection<T>;
		},

		keyValue<T extends object>(
			name: string,
			kvOptions: KeyValueOptions<T> & {
				defaultValue?: (key: string) => T;
			} = {},
		) {
			assertOpen();
			const found = existing(
				"keyValue",
				name,
				kvOptions.remote,
				kvOptions.remote !== undefined,
			);
			if (found !== undefined) return found.handle as KeyValueStore<T>;
			const registration = register<T>("keyValue", name, kvOptions);
			const store = createKeyValueStore<T>(
				registration.collection as unknown as Collection<T>,
				registration.engine as SyncEngine | undefined,
				kvOptions.defaultValue,
			);
			registration.handle = store;
			return store;
		},

		source<T extends object, Filter = unknown, Cursor = unknown>(
			name: string,
			sourceOptions: SourceOptions<T, Filter, Cursor>,
		): Source<T, Filter> {
			assertOpen();
			const found = existing("source", name, undefined, false);
			if (found !== undefined) return found.handle as Source<T, Filter>;
			const registration = register<T>(
				"source",
				name,
				{
					...(sourceOptions.validator !== undefined
						? { validator: sourceOptions.validator }
						: {}),
					// Started below.
					autoSync: false,
				},
				(collection) =>
					createSourceEngine<T, Filter, Cursor>(name, collection, {
						...sourceOptions,
						network: getNetwork(),
						now: ctx.now,
					}) as unknown as SyncEngine<never>,
			);
			const engine = registration.engine as unknown as SyncEngine<Filter>;
			const view = toReadonlyCollection(
				registration.collection as unknown as Collection<T>,
			);
			if (sourceOptions.autoSync ?? true) {
				registration.startOptions = {
					syncOnStart: true,
					...(sourceOptions.refreshIntervalMs !== undefined
						? { intervalMs: sourceOptions.refreshIntervalMs }
						: {}),
				};
				startIfAllowed(name, registration);
			}
			const source = createSource<T, Filter>(view, engine, (filter) =>
				multiTab?.announceFilter(name, filter),
			);
			registration.handle = source;
			return source;
		},

		engine: (name: string) =>
			ctx.registry.get(name)?.engine as SyncEngine | undefined,

		hasCollection: (name: string) => ctx.registry.has(name),

		get collections() {
			return [...ctx.registry.keys()];
		},

		async ready() {
			await Promise.all(
				[...ctx.registry.values()].map((r) => r.collection.load()),
			);
		},

		async sync() {
			const engines = [...ctx.registry.values()].flatMap((r) =>
				r.engine === undefined ? [] : [r.engine],
			);
			const results = await Promise.allSettled(engines.map((e) => e.sync()));
			const failures = results.flatMap((r) =>
				r.status === "rejected" ? [r.reason] : [],
			);
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(
					failures,
					`${failures.length} collections failed to sync`,
				);
			}
		},

		status,

		on<K extends keyof LocalSyncAppEventMap>(
			type: K,
			listener: Listener<LocalSyncAppEventMap[K]>,
		): Unsubscribe {
			return ctx.events.on(type, listener);
		},

		async close() {
			if (ctx.disposed) return;
			ctx.disposed = true;
			stopVisibleSync?.();
			const registrations = [...ctx.registry.values()];
			const engines = registrations.flatMap((r) =>
				r.engine === undefined ? [] : [r.engine],
			);
			// Give scheduled pushes a brief chance to go out; anything left stays dirty in
			// storage and is pushed by the next session.
			let timeout: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.allSettled(engines.map((e) => e.flush())),
				new Promise((resolve) => {
					timeout = setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS);
				}),
			]);
			clearTimeout(timeout);
			for (const engine of engines) engine.dispose();
			// Let every queued local write land before closing storage (closing first would make
			// the storage adapter reopen behind our back); other tabs still hear about them.
			await Promise.all(registrations.map((r) => r.collection.whenPersisted()));
			multiTab?.dispose(); // releases the leader lock, so another tab takes over syncing right away
			status.dispose();
			if (ownsNetwork) network?.dispose();
			for (const r of registrations) r.collection.dispose();
			ctx.registry.clear();
			await ctx.storage.close();
			ctx.events.emit("disposed");
		},
	};
	return app;
}
