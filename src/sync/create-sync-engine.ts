import type { Collection } from "../collections/collection-types.js";
import { createEventBus } from "../events/event-bus.js";
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { NetworkStatus } from "../network/network-status.js";
import type { RecordEnvelope } from "../records/record-envelope.js";
import { deepEqual } from "../utils/deep-equal.js";
import { createSerialTask } from "../utils/serial-task.js";
import { now as defaultNow } from "../utils/timestamps.js";
import type { PullArgs, SyncAdapter } from "./sync-adapter.js";
import type {
	PushOnChangeOptions,
	SyncEngine,
	SyncStartOptions,
} from "./sync-engine.js";
import { DEFAULT_PUSH_DEBOUNCE_MS } from "./sync-engine.js";
import type { SyncEventMap } from "./sync-events.js";
import { buildMutations } from "./sync-queue.js";
import type { RetryOptions, Sleep } from "./sync-retries.js";
import { withRetry } from "./sync-retries.js";
import { createSyncStatus } from "./sync-status.js";

/** Hard stop for a paginated pull, so a misbehaving adapter can't loop forever. */
const MAX_PULL_PAGES = 1000;
/**
 * After this many consecutive conflict rejections for one record, stop auto-resolving and
 * hold it back (as if rejected outright) -- protects against an adapter that always rejects.
 */
const MAX_CONSECUTIVE_CONFLICTS = 3;

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
	 * Keeps local storage from accumulating deleted records. Default false: only enable it for an
	 * adapter whose pulls stop returning a tombstone once it's acknowledged. If pulls keep
	 * returning it (e.g. `createBlobSyncAdapter`, which keeps tombstones so other clients learn
	 * of the delete), every pull re-adds it, and re-creating a deleted id starts over at version 1
	 * -- which the remote then rejects as stale.
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
	let filterGeneration = 0;
	let cursor: Cursor | undefined;
	let started = false;
	let disposed = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	// Records the remote rejected without sending its copy: id -> the version that was rejected.
	// They stay dirty but aren't pushed again until edited (i.e. their version changes).
	const heldBack = new Map<string, number>();
	// Consecutive conflict rejections per record, while it stays dirty: reset once the record is
	// clean again (acknowledged, or the merge settled it on the remote's copy).
	const conflictCounts = new Map<string, number>();

	const status = createSyncStatus({ online: network?.isOnline() ?? true });
	const events = createEventBus<SyncEventMap>();

	const isHeldBack = (record: RecordEnvelope<T>): boolean =>
		heldBack.get(record.id) === record.meta.version;

	// The push backlog is simply the collection's dirty records (durable via storage).
	const updatePending = (): void => {
		const dirty = collection.pending();
		const dirtyVersions = new Map(dirty.map((r) => [r.id, r.meta.version]));
		for (const [id, version] of heldBack) {
			// Edited since (new version), synced, or removed: no longer held back.
			if (dirtyVersions.get(id) !== version) heldBack.delete(id);
		}
		for (const id of conflictCounts.keys()) {
			if (!dirtyVersions.has(id)) conflictCounts.delete(id);
		}
		status.patch({ pending: dirty.length, rejected: heldBack.size });
	};
	const guardOnline = (): boolean =>
		network === undefined || network.isOnline();

	// --- core operations (no status/event bookkeeping; that's added by the wrapper) ---

	const runPull = async (): Promise<void> => {
		if (!collection.hydrated) await collection.load();
		// Records a snapshot must keep: those in any page, plus any changed during the pull by
		// something else (e.g. a push acked between pages) -- earlier pages predate that change,
		// so they can't prove the record is gone.
		const seen = new Set<string>();
		const stopWatching = collection.subscribe(({ changes }) => {
			for (const change of changes) seen.add(change.id);
		});
		try {
			await pullPages(seen);
		} finally {
			stopWatching();
		}
	};

	const pullPages = async (seen: Set<string>): Promise<void> => {
		const generation = filterGeneration;
		const startCursor = cursor;
		let pageCursor = startCursor;
		let lastCursor: Cursor | undefined;
		let complete = false;
		let count = 0;
		for (let page = 1; ; page++) {
			const args: PullArgs<Filter, Cursor> = {};
			if (filter !== undefined) args.filter = filter;
			if (pageCursor !== undefined) args.cursor = pageCursor;
			const result = await withRetry(() => adapter.pull(args), retry, sleep);
			if (disposed) return;
			// The filter changed while this page was loading: these results are for the old
			// filter, so drop them (setFilter queued a fresh pull for the new one).
			if (generation !== filterGeneration) return;
			// Pull preserves un-pushed local edits (optimistic-until-acknowledged) when enabled.
			collection.applyRemote(result.records, {
				keepPending: keepPendingOnPull,
			});
			count += result.records.length;
			for (const record of result.records) seen.add(record.id);
			if (result.cursor !== undefined) lastCursor = result.cursor;
			if (result.complete) {
				complete = true;
				break;
			}
			if (!result.hasMore) break;
			if (result.cursor === undefined || deepEqual(result.cursor, pageCursor)) {
				throw new Error(
					`Pull for collection "${collection.name}" returned hasMore without a new cursor; ` +
						"stopping to avoid an endless loop. Return the next page's cursor with hasMore.",
				);
			}
			if (page >= MAX_PULL_PAGES) {
				throw new Error(
					`Pull for collection "${collection.name}" exceeded ${MAX_PULL_PAGES} pages; stopping.`,
				);
			}
			pageCursor = result.cursor;
		}
		// Only now -- after every page succeeded -- act on the pull as a whole. (Advancing the
		// cursor page-by-page would make a retried snapshot resume mid-way and then treat the
		// records from the pages it skipped as deleted.)
		if (complete) collection.removeUnseen(seen);
		cursor = complete ? undefined : (lastCursor ?? startCursor);
		events.emit("pull:success", { count });
	};

	/** Returns true if a conflict was resolved into a local edit that should be pushed again. */
	const runPush = async (): Promise<boolean> => {
		if (!collection.hydrated) await collection.load();
		const pushFn = adapter.push;
		if (pushFn === undefined) return false;
		const toPush = collection.pending().filter((r) => !isHeldBack(r));
		const mutations = buildMutations(collection.name, toPush);
		if (mutations.length === 0) return false;
		// Remember exactly which record objects were pushed, to detect records that changed
		// locally (edited, deleted, or replaced by another tab's write) while the push was
		// in flight. Records are immutable, so "same object" means "same content" -- unlike a
		// version number, which two tabs can independently bump to the same value.
		const pushedRecords = new Map(mutations.map((m) => [m.recordId, m.record]));
		const result = await withRetry(() => pushFn(mutations), retry, sleep);
		if (disposed) return false;
		// Only records that are still exactly what was pushed may take the server's response
		// or be marked synced; applying it to anything newer would overwrite that change
		// (e.g. resurrecting a record the user deleted during the round-trip).
		// Re-checked after each step below, since each step changes records.
		let pendingNow = new Map<string, RecordEnvelope<T>>();
		const recheck = (): void => {
			pendingNow = new Map(collection.pending().map((r) => [r.id, r]));
		};
		const unchanged = (id: string): boolean => {
			const p = pendingNow.get(id);
			return p !== undefined && p === pushedRecords.get(id);
		};
		recheck();
		const freshRecords = (result.records ?? []).filter((r) => unchanged(r.id));

		// Acks first: an acknowledged record is then clean, so the server's copy of it (below)
		// simply replaces it, rather than being "merged" with the very edit it accepted.
		// (A record edited during the push stays dirty, but builds on the accepted version.)
		const ackedSet = new Set(result.acked);
		collection.acknowledge(
			mutations.filter((m) => ackedSet.has(m.mutationId)).map((m) => m.record),
		);
		if (freshRecords.length > 0) collection.applyRemote(freshRecords);
		recheck();

		let repush = false;
		const byMutationId = new Map(mutations.map((m) => [m.mutationId, m]));
		for (const rejection of result.rejected ?? []) {
			const mutation = byMutationId.get(rejection.mutationId);
			if (mutation === undefined || !unchanged(mutation.recordId)) continue;
			const id = mutation.recordId;
			const conflicts = (conflictCounts.get(id) ?? 0) + 1;
			if (
				rejection.record !== undefined &&
				conflicts <= MAX_CONSECUTIVE_CONFLICTS
			) {
				conflictCounts.set(id, conflicts);
				collection.applyRemote([{ ...rejection.record, id }]);
				// The remote's copy is this device's own earlier save that this edit came after
				// (e.g. its reply was lost): the collection builds on it, and it's no conflict
				// worth reporting. (Same test as the collection's.)
				const ownSave =
					rejection.record.meta.writer !== undefined &&
					rejection.record.meta.writer === collection.deviceId &&
					mutation.record.meta.version > rejection.record.meta.version;
				if (!ownSave) events.emit("conflict", { id, reason: rejection.reason });
				repush = true;
			} else {
				heldBack.set(id, mutation.record.meta.version);
				events.emit("push:rejected", { id, reason: rejection.reason });
			}
		}

		if (purgeDeletedOnPush) collection.purgeDeleted();
		events.emit("push:success", { count: result.acked.length });
		return repush;
	};

	// --- public operations (with status + event bookkeeping) ---

	// The latest unresolved failure per direction. Tracked separately so that a successful
	// pull doesn't hide a push that keeps failing (or vice versa): the phase stays "error"
	// until every direction that failed has succeeded again.
	const failures: { pull?: string; push?: string } = {};

	const publishOutcome = (): void => {
		const lastError = failures.push ?? failures.pull;
		status.patch({
			phase: lastError === undefined ? "idle" : "error",
			lastError,
		});
	};

	// Once something has failed, stay in "error" while retrying until it succeeds --
	// otherwise periodic retries would flip the phase back to "syncing" and a status badge
	// would only flash the failure between attempts.
	const markBusy = (): void => {
		if (status.get().phase !== "error") status.patch({ phase: "syncing" });
	};

	const reportFailure = (direction: "pull" | "push", err: unknown): void => {
		failures[direction] = String(err);
		publishOutcome();
		events.emit("sync:error", { phase: direction, error: err });
	};

	const succeed = (direction: "pull" | "push", startedAt: number): void => {
		delete failures[direction];
		const finishedAt = clock();
		status.patch({
			lastSyncedAt: finishedAt,
			lastSyncDurationMs: finishedAt - startedAt,
		});
		publishOutcome();
		updatePending();
	};

	// Each direction runs one pass at a time; a call made meanwhile gets one more pass
	// afterwards. A pass that fails while another is queued (e.g. a pull for a filter that
	// was just changed) gives way to that one instead of reporting its error.

	// One pull at a time: overlapping pulls could finish out of order, letting an older
	// (e.g. previous-filter) result overwrite a newer one.
	const pullTask = createSerialTask(
		async () => {
			if (disposed || !guardOnline()) return;
			const startedAt = clock();
			events.emit("sync:start", { direction: "pull" });
			markBusy();
			await runPull();
			succeed("pull", startedAt);
		},
		{ onFailure: (err) => reportFailure("pull", err) },
	);

	const pushTask = createSerialTask(
		async () => {
			if (!collection.hydrated) await collection.load();
			if (disposed || !guardOnline()) return false;
			if (!collection.pending().some((r) => !isHeldBack(r))) {
				// Nothing left that could fail to push: an earlier push failure no longer applies.
				if (failures.push !== undefined) {
					delete failures.push;
					publishOutcome();
				}
				return false;
			}
			const startedAt = clock();
			events.emit("sync:start", { direction: "push" });
			markBusy();
			const repush = await runPush();
			succeed("push", startedAt);
			return repush;
		},
		{ onFailure: (err) => reportFailure("push", err) },
	);

	// Failures are already reported by the push/pull they came from.
	const syncTask = createSerialTask(async () => {
		if (disposed || !guardOnline()) return;
		// Pull even if the push failed: a push that keeps failing (e.g. the server rejects
		// the batch) must not also stop this device from receiving everyone else's changes.
		let pushError: { error: unknown } | undefined;
		try {
			await push();
		} catch (error) {
			pushError = { error };
		}
		await pull();
		if (pushError !== undefined) throw pushError.error;
		events.emit("sync:success", { direction: "full" });
	});

	const pull = async (): Promise<void> => {
		if (disposed || !guardOnline()) return;
		await pullTask.run();
	};

	const push = async (): Promise<void> => {
		if (disposed || !guardOnline()) return;
		if (adapter.push === undefined) return;
		await pushTask.run();
	};

	const sync = async (): Promise<void> => {
		if (disposed || !guardOnline()) return;
		await syncTask.run();
	};

	// --- debounced push-on-change ---

	let pushConfig: Required<PushOnChangeOptions> | undefined;
	let pushTimer: ReturnType<typeof setTimeout> | undefined;
	let microtaskQueued = false;
	let burstStartedAt: number | undefined;

	const cancelScheduledPush = (): void => {
		if (pushTimer !== undefined) clearTimeout(pushTimer);
		pushTimer = undefined;
		microtaskQueued = false;
		burstStartedAt = undefined;
		status.patch({ pushScheduled: false });
	};

	const isPushScheduled = (): boolean =>
		pushTimer !== undefined || microtaskQueued;

	const runScheduledPush = (): Promise<void> => {
		cancelScheduledPush();
		if (disposed) return Promise.resolve();
		return push().catch(() => {}); // surfaced via sync:error / status, never rejects here
	};

	const schedulePush = (): void => {
		if (pushConfig === undefined) return;
		const { debounceMs, maxWaitMs } = pushConfig;
		if (debounceMs <= 0) {
			if (microtaskQueued) return;
			microtaskQueued = true;
			status.patch({ pushScheduled: true });
			queueMicrotask(() => {
				if (microtaskQueued) void runScheduledPush();
			});
			return;
		}
		const now = clock();
		burstStartedAt ??= now;
		if (pushTimer !== undefined) clearTimeout(pushTimer);
		const untilMaxWait = burstStartedAt + maxWaitMs - now;
		pushTimer = setTimeout(
			() => void runScheduledPush(),
			Math.max(0, Math.min(debounceMs, untilMaxWait)),
		);
		status.patch({ pushScheduled: true });
	};

	// A push already running is waited for too: closing during it would otherwise drop the
	// server's answer, leaving a saved change marked unpushed (and its next edit "conflicting").
	const flush = (): Promise<void> => {
		if (isPushScheduled()) return runScheduledPush();
		if (pushTask.running) return push().catch(() => {});
		return Promise.resolve();
	};

	// Flush a scheduled push when the page is hidden or closed, so a quick edit-then-close
	// still reaches the server. Best effort: if the browser kills the request, the change is
	// still dirty in storage and is pushed on the next sync.
	let detachHideFlush: Unsubscribe | undefined;
	const attachHideFlush = (): void => {
		if (
			detachHideFlush !== undefined ||
			typeof document === "undefined" ||
			typeof window === "undefined"
		) {
			return;
		}
		const onVisibility = () => {
			if (document.visibilityState === "hidden") void flush();
		};
		const onPageHide = () => void flush();
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onPageHide);
		detachHideFlush = () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onPageHide);
			detachHideFlush = undefined;
		};
	};

	// --- wiring: keep the pending count fresh and auto-push on local change ---

	const collectionSub = collection.subscribe(({ changes }) => {
		updatePending();
		// Only a local edit (a dirty record) schedules a push -- not remote data or acks.
		const hasLocalEdit = changes.some((c) => c.record?.meta.dirty === true);
		if (
			started &&
			hasLocalEdit &&
			adapter.push !== undefined &&
			guardOnline()
		) {
			schedulePush();
		}
	});

	// Once hydration completes, dirty records loaded from storage are already "pending"
	// (no seeding needed -- the dirty flag is the backlog); just refresh the count.
	void collection.ready.then(
		() => {
			if (!disposed) updatePending();
		},
		() => {}, // hydration failures surface through pull/push (which retry the load)
	);

	// --- wiring: react to connectivity ---

	let networkSub: Unsubscribe | undefined;
	if (network !== undefined) {
		networkSub = network.subscribe((online) => {
			status.patch({ online });
			if (online && started) void sync().catch(() => {});
		});
	}

	const stop = (): void => {
		started = false;
		pushConfig = undefined;
		cancelScheduledPush();
		detachHideFlush?.();
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	return {
		status,
		getState: () => status.get(),
		pull,
		push,
		sync,
		flush,
		setFilter(next: Filter) {
			filter = next;
			filterGeneration += 1;
			cursor = undefined;
			// A pull already running for the old filter discards its results; run another for
			// the new filter once it stops.
			pullTask.rerunIfRunning();
		},
		start(startOptions: SyncStartOptions = {}) {
			if (disposed) return;
			// Calling start() again replaces the previous configuration -- without dropping a
			// push that was already scheduled.
			const hadScheduledPush = isPushScheduled();
			stop();
			started = true;
			const pushOnChange = startOptions.pushOnChange ?? false;
			if (pushOnChange !== false) {
				const debounceMs =
					(pushOnChange === true ? undefined : pushOnChange.debounceMs) ??
					DEFAULT_PUSH_DEBOUNCE_MS;
				const maxWaitMs =
					(pushOnChange === true ? undefined : pushOnChange.maxWaitMs) ??
					debounceMs * 10;
				pushConfig = { debounceMs, maxWaitMs };
				attachHideFlush();
			}
			if (startOptions.syncOnStart ?? true) void sync().catch(() => {});
			else if (hadScheduledPush) {
				if (pushConfig !== undefined) schedulePush();
				else void runScheduledPush();
			}
			if (
				startOptions.intervalMs !== undefined &&
				startOptions.intervalMs > 0
			) {
				timer = setInterval(() => {
					void sync().catch(() => {});
				}, startOptions.intervalMs);
			}
		},
		stop,
		on<K extends keyof SyncEventMap>(
			type: K,
			listener: Listener<SyncEventMap[K]>,
		): Unsubscribe {
			return events.on(type, listener);
		},
		dispose() {
			if (disposed) return;
			stop();
			disposed = true;
			collectionSub();
			networkSub?.();
		},
	};
}
