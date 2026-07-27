import type { Collection } from "../collections/collection-types.js";
import { createEventBus } from "../events/event-bus.js";
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { NetworkStatus } from "../network/network-status.js";
import { now as defaultNow } from "../utils/timestamps.js";
import type { PullArgs, SyncAdapter } from "./sync-adapter.js";
import type { SyncEngine, SyncStartOptions } from "./sync-engine.js";
import type { SyncEventMap } from "./sync-events.js";
import { buildMutations } from "./sync-queue.js";
import type { RetryOptions, Sleep } from "./sync-retries.js";
import { withRetry } from "./sync-retries.js";
import { createSyncStatus } from "./sync-status.js";

export interface CreateSyncEngineOptions<
	T extends object,
	Filter = unknown,
	Cursor = unknown,
> {
	collection: Collection<T>;
	adapter: SyncAdapter<T, Filter, Cursor>;
	/** Optional connectivity source; when offline, sync work is skipped. */
	network?: NetworkStatus;
	/** Initial pull filter. */
	filter?: Filter;
	/** Retry/backoff policy for pull/push. */
	retry?: RetryOptions;
	/** Injectable sleep (tests pass a no-op to avoid real delays). */
	sleep?: Sleep;
	/** Injectable clock. */
	now?: () => number;
	/**
	 * Optimistic-until-acknowledged: when true (default), a pull will NOT overwrite records with
	 * un-pushed local edits -- your optimistic change stays visible until you push it, and the
	 * server's push response then resolves it. Set false to resolve conflicts at pull time via
	 * the merge strategy (the server may win and discard the local edit).
	 */
	keepPendingOnPull?: boolean;
	/**
	 * After a successful push, hard-remove tombstones the remote has now acknowledged (compaction).
	 * Keeps local storage from accumulating deleted records. Default false.
	 */
	purgeDeletedOnPush?: boolean;
}

export function createSyncEngine<
	T extends object,
	Filter = unknown,
	Cursor = unknown,
>(options: CreateSyncEngineOptions<T, Filter, Cursor>): SyncEngine<Filter> {
	const { collection, adapter, network } = options;
	const clock = options.now ?? defaultNow;
	const retry = options.retry ?? {};
	const sleep = options.sleep;

	const keepPendingOnPull = options.keepPendingOnPull ?? true;
	const purgeDeletedOnPush = options.purgeDeletedOnPush ?? false;
	let filter = options.filter;
	let cursor: Cursor | undefined;
	let started = false;
	let pushOnChange = false;
	let disposed = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let pushScheduled = false;
	let pushInFlight: Promise<void> | undefined;
	let pushRequestedWhileRunning = false;
	let syncInFlight: Promise<void> | undefined;
	let syncRequestedWhileRunning = false;

	const status = createSyncStatus({ online: network?.isOnline() ?? true });
	const events = createEventBus<SyncEventMap>();

	// The push backlog is simple the collection's dirty records (durable via storage).
	const updatePending = (): void =>
		status.patch({ pending: collection.pending().length });
	const guardOnline = (): boolean =>
		network === undefined || network.isOnline();

	// --- core operations (no status/event bookkeeping; that's added by the wrapper) ---

	const runPull = async (): Promise<void> => {
		const args: PullArgs<Filter, Cursor> = {};
		if (filter !== undefined) args.filter = filter;
		if (cursor !== undefined) args.cursor = cursor;
		const result = await withRetry(() => adapter.pull(args), retry, sleep);
		// Pull preserves un-pushed local edits (optimistic-until-acknowledged) when enabled.
		collection.applyRemote(result.records, { keepPending: keepPendingOnPull });
		if (result.cursor !== undefined) cursor = result.cursor;
		events.emit("pull:success", { count: result.records.length });
	};

	const runPush = async (): Promise<void> => {
		const pushFn = adapter.push;
		if (pushFn === undefined) return;
		const mutations = buildMutations(collection.name, collection.pending());
		if (mutations.length === 0) return;
		// Snapshot the version of every record being pushed so we can detect records
		// that were locally modified (e.g. deleted) while the push was in-flight.
		const pushedVersions = new Map<string, number>(
			mutations.map((m) => [m.recordId, m.record.meta.version]),
		);
		const result = await withRetry(() => pushFn(mutations), retry, sleep);
		// Re-check which pushed records still have the same local version. A version
		// mismatch means the record was edited or deleted while the push was in-flight;
		// applying the now-stale server response would overwrite those changes (e.g.
		// resurrecting a record the user deleted during the round-trip).
		const pendingNow = new Map(collection.pending().map((r) => [r.id, r]));
		const unchanged = (id: string): boolean => {
			const p = pendingNow.get(id);
			return p !== undefined && p.meta.version === pushedVersions.get(id);
		};
		if (result.records !== undefined && result.records.length > 0) {
			const freshRecords = result.records.filter((r) => unchanged(r.id));
			if (freshRecords.length > 0) collection.applyRemote(freshRecords);
		}
		const ackedSet = new Set(result.acked);
		const ackedRecordIds = mutations
			.filter((m) => ackedSet.has(m.mutationId) && unchanged(m.recordId))
			.map((m) => m.recordId);
		collection.markSynced(ackedRecordIds);
		if (purgeDeletedOnPush) collection.purgeDeleted();
		events.emit("push:success", { count: result.acked.length });
	};

	// --- public operations (with status + event bookkeeping) ---

	const pull = async (): Promise<void> => {
		if (disposed || !guardOnline()) return;
		const startedAt = clock();
		events.emit("sync:start", { direction: "pull" });
		status.patch({ phase: "syncing" });
		try {
			await runPull();
			const finishedAt = clock();
			status.patch({
				phase: "idle",
				lastSyncedAt: finishedAt,
				lastSyncDurationMs: finishedAt - startedAt,
				lastError: undefined,
			});
			updatePending();
		} catch (err) {
			status.patch({ phase: "idle", lastError: String(err) });
			events.emit("sync:error", { phase: "pull", error: err });
			throw err;
		}
	};

	const push = async (): Promise<void> => {
		if (disposed || !guardOnline()) return;
		if (adapter.push === undefined || collection.pending().length === 0) return;
		if (pushInFlight !== undefined) {
			pushRequestedWhileRunning = true;
			await pushInFlight;
			return;
		}

		pushInFlight = (async () => {
			do {
				pushRequestedWhileRunning = false;
				if (disposed || !guardOnline()) return;
				if (adapter.push === undefined || collection.pending().length === 0)
					return;
				const startedAt = clock();
				events.emit("sync:start", { direction: "push" });
				status.patch({ phase: "syncing" });
				try {
					await runPush();
					const finishedAt = clock();
					status.patch({
						phase: "idle",
						lastSyncedAt: finishedAt,
						lastSyncDurationMs: finishedAt - startedAt,
						lastError: undefined,
					});
					updatePending();
				} catch (err) {
					status.patch({ phase: "idle", lastError: String(err) });
					events.emit("sync:error", { phase: "push", error: err });
					throw err;
				}
			} while (pushRequestedWhileRunning);
		})();

		try {
			await pushInFlight;
		} finally {
			pushInFlight = undefined;
		}
	};

	const sync = async (): Promise<void> => {
		if (disposed || !guardOnline()) return;
		if (syncInFlight !== undefined) {
			syncRequestedWhileRunning = true;
			await syncInFlight;
			return;
		}

		syncInFlight = (async () => {
			do {
				syncRequestedWhileRunning = false;
				if (disposed || !guardOnline()) return;
				const _startedAt = clock();
				await push();
				await pull();
				events.emit("sync:success", { direction: "full" });
			} while (syncRequestedWhileRunning);
		})();

		try {
			await syncInFlight;
		} finally {
			syncInFlight = undefined;
		}
	};

	const schedulePush = (): void => {
		if (pushScheduled) return;
		pushScheduled = true;
		queueMicrotask(() => {
			pushScheduled = false;
			if (!disposed) void push().catch(() => {});
		});
	};

	// --- wiring: keep the pending count fresh and auto-push on local change ---

	const collectionSub = collection.subscribe(() => {
		updatePending();
		if (
			started &&
			pushOnChange &&
			adapter.push !== undefined &&
			guardOnline()
		) {
			schedulePush();
		}
	});

	// Once hydration completes, dirty records loaded from storage are already "pending"
	// (no seeding needed -- the dirty flag is the backlog); just refresh the count.
	void collection.ready.then(() => {
		if (!disposed) updatePending();
	});

	// --- wiring: react to connectivity ---

	let networkSub: Unsubscribe | undefined;
	if (network !== undefined) {
		networkSub = network.subscribe((online) => {
			status.patch({ online });
			if (online && started) void sync().catch(() => {});
		});
	}

	return {
		status,
		getState: () => status.get(),
		pull,
		push,
		sync,
		setFilter(next: Filter) {
			filter = next;
			cursor = undefined;
		},
		start(startOptions: SyncStartOptions = {}) {
			started = true;
			pushOnChange = startOptions.pushOnChange ?? false;
			if (startOptions.syncOnStart ?? true) void sync().catch(() => {});
			if (
				startOptions.intervalMs !== undefined &&
				startOptions.intervalMs > 0
			) {
				timer = setInterval(() => {
					void sync().catch(() => {});
				}, startOptions.intervalMs);
			}
		},
		stop() {
			started = false;
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		},
		on<K extends keyof SyncEventMap>(
			type: K,
			listener: Listener<SyncEventMap[K]>,
		): Unsubscribe {
			return events.on(type, listener);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			started = false;
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
			collectionSub();
			networkSub?.();
		},
	};
}
