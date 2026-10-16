/**
 * Sync engines: when and how often to pull and push, with status, retries, offline handling,
 * a debounced push after local edits, and a flush when the page is hidden or closed.
 *
 * `createSyncEngine` syncs a collection with a `SyncAdapter`:
 *   - pull: read the remote's entries and merge them in.
 *   - push: read the remote's entries, merge them in, and -- if this side has entries the
 *     remote lacks -- write the merge of both with compare-and-swap (`ifMatch`), re-reading
 *     and retrying if someone else wrote first.
 * Both are merges (see crdt/lww-map.ts), so it doesn't matter if a pull is stale, a reply is
 * lost, a push repeats, or another tab or device syncs at the same moment: whatever is read
 * is merged, and an entry is only "pending" until the remote is seen to hold it.
 *
 * `createEngine` is the scheduling core, shared with read-only sources (see app/source.ts).
 */
import type { Collection } from "../collections/collection-types.js";
import { stampAt } from "../crdt/hlc.js";
import type { Entry } from "../crdt/lww-map.js";
import { keysNewerIn, mergeEntries } from "../crdt/lww-map.js";
import { createEventBus } from "../events/event-bus.js";
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { NetworkStatus } from "../network/network-status.js";
import { createSerialTask } from "../utils/serial-task.js";
import { now as defaultNow } from "../utils/timestamps.js";
import type { RemoteState, SyncAdapter } from "./sync-adapter.js";
import type {
	PushOnChangeOptions,
	SyncEngine,
	SyncStartOptions,
} from "./sync-engine.js";
import { DEFAULT_PUSH_DEBOUNCE_MS } from "./sync-engine.js";
import type { SyncEventMap } from "./sync-events.js";
import type { RetryOptions, Sleep } from "./sync-retries.js";
import { withRetry } from "./sync-retries.js";
import { createSyncStatus } from "./sync-status.js";

/** Compare-and-swap conflicts in a row before a push attempt counts as failed (and retries). */
const MAX_WRITE_CONFLICTS = 5;
/** How long a delete is kept on the remote (as a tombstone) before a push drops it. */
export const DEFAULT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreateSyncEngineOptions<T extends object> {
	collection: Collection<T>;
	adapter: SyncAdapter<T>;
	/** Optional connectivity source; when offline, sync work is skipped. */
	network?: NetworkStatus;
	/** Retry/backoff policy for pull/push. */
	retry?: RetryOptions;
	/** Injectable sleep (tests pass a no-op to avoid real delays). */
	sleep?: Sleep;
	/** Injectable clock. */
	now?: () => number;
	/**
	 * How long deletes are kept on the remote. A push drops older ones, and a device removes a
	 * key the remote no longer has once its own copy is this old (and has no unsaved edit).
	 * A device offline for longer, with an unsaved edit to a key deleted meanwhile, brings
	 * that key back. Default 30 days.
	 */
	tombstoneTtlMs?: number;
}

export function createSyncEngine<T extends object>(
	options: CreateSyncEngineOptions<T>,
): SyncEngine {
	const { collection, adapter } = options;
	const retrying = <R>(fn: () => Promise<R>) =>
		withRetry(fn, options.retry ?? {}, options.sleep);
	const clock = options.now ?? defaultNow;
	const ttl = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
	/** Deletes stamped before this are old enough to forget. */
	const horizon = () => stampAt(Math.max(0, clock() - ttl));

	/** The last read showed the remote lacking entries this side holds (e.g. it was cleared). */
	let remoteBehind = false;

	const take = (remote: RemoteState<T>): void => {
		if (remote.imported !== undefined && remote.imported.size > 0) {
			collection.mergeRemote(remote.imported); // not on the remote yet: pending
		}
		collection.mergeRemote(remote.entries, { synced: true });
		// A key the remote dropped (an old delete) goes here too. Not if the remote is empty:
		// that's a new, cleared or lost document (a push only drops old deletes), and this
		// device's data is pushed back instead.
		if (remote.entries.size > 0) collection.prune(remote.entries, horizon());
		remoteBehind =
			keysNewerIn(collection.snapshot(), remote.entries).length > 0;
	};

	const write = adapter.write?.bind(adapter);
	const push =
		write === undefined
			? undefined
			: () =>
					retrying(async () => {
						for (let conflicts = 0; ; conflicts++) {
							const remote = await adapter.read();
							take(remote);
							const local = collection.snapshot();
							const outgoing = keysNewerIn(local, remote.entries);
							if (outgoing.length === 0) return; // the remote has everything
							const merged = mergeEntries(remote.entries, local);
							const cutoff = horizon();
							for (const [key, entry] of merged) {
								if (entry.deleted && entry.stamp < cutoff) merged.delete(key);
							}
							const result = await write(
								merged,
								remote.etag === undefined ? {} : { ifMatch: remote.etag },
							);
							if (result?.conflict !== true) {
								const saved = new Map<string, Entry<T>>();
								for (const key of outgoing) {
									// (A dropped old delete counts as saved; the next read prunes it.)
									saved.set(
										key,
										merged.get(key) ?? (local.get(key) as Entry<T>),
									);
								}
								collection.mergeRemote(saved, { synced: true });
								collection.prune(merged, cutoff); // the old deletes just dropped
								remoteBehind = false;
								return;
							}
							if (conflicts + 1 >= MAX_WRITE_CONFLICTS) {
								throw new Error(
									`Writing "${collection.name}" kept conflicting (it is being changed concurrently)`,
								);
							}
						}
					});

	return createEngine({
		...(options.network !== undefined ? { network: options.network } : {}),
		...(options.now !== undefined ? { now: options.now } : {}),
		load: () => collection.load(),
		async pull() {
			take(await retrying(() => adapter.read()));
			return true;
		},
		...(push !== undefined ? { push } : {}),
		pendingCount: () => collection.pending().length,
		pushNeeded: () => remoteBehind,
		watch: (onChange) =>
			collection.subscribe(({ changes }) => {
				const pending = new Set(collection.pending());
				onChange(changes.some((c) => pending.has(c.id)));
			}),
	});
}

/** What an engine drives. */
export interface EngineOperations {
	network?: NetworkStatus;
	now?: () => number;
	/** Load local data (retrying a failed load). */
	load(): Promise<void>;
	/** Fetch and apply the remote's data. Resolves false if abandoned (e.g. the filter changed). */
	pull(): Promise<boolean>;
	/** Save local changes (and take in the remote's). Omit when read-only. */
	push?: () => Promise<void>;
	/** How many local changes are waiting to be pushed. */
	pendingCount(): number;
	/** Whether to push even with nothing pending (the remote lost data this side holds). */
	pushNeeded?: () => boolean;
	/** Report local data changes; `pushNeeded` if they include changes to push. */
	watch(onChange: (pushNeeded: boolean) => void): Unsubscribe;
	setFilter?(filter: unknown): void;
}

export function createEngine<Filter = unknown>(
	ops: EngineOperations,
): SyncEngine<Filter> {
	const { network } = ops;
	const clock = ops.now ?? defaultNow;
	let started = false;
	let disposed = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const status = createSyncStatus({ online: network?.isOnline() ?? true });
	const events = createEventBus<SyncEventMap>();

	const updatePending = (): void => {
		status.patch({ pending: ops.pendingCount() });
	};
	const guardOnline = (): boolean =>
		network === undefined || network.isOnline();

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

	const succeed = (
		directions: ReadonlyArray<"pull" | "push">,
		startedAt: number,
	): void => {
		for (const direction of directions) delete failures[direction];
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

	const pullTask = createSerialTask(
		async () => {
			if (disposed || !guardOnline()) return;
			const startedAt = clock();
			events.emit("sync:start", { direction: "pull" });
			markBusy();
			await ops.load();
			if (await ops.pull()) {
				succeed(["pull"], startedAt);
				events.emit("pull:success");
			}
			// Abandoned: nothing was synced, so no success to record (or failure to clear).
			else publishOutcome();
		},
		{ onFailure: (err) => reportFailure("pull", err) },
	);

	const pushTask = createSerialTask(
		async () => {
			await ops.load();
			if (disposed || !guardOnline() || ops.push === undefined) return;
			if (ops.pendingCount() === 0 && ops.pushNeeded?.() !== true) {
				// Nothing left that could fail to push: an earlier push failure no longer applies.
				if (failures.push !== undefined) {
					delete failures.push;
					publishOutcome();
				}
				return;
			}
			const startedAt = clock();
			events.emit("sync:start", { direction: "push" });
			markBusy();
			await ops.push();
			// A push reads (and merges) the remote too, so it's also a successful pull.
			succeed(["push", "pull"], startedAt);
			events.emit("push:success");
		},
		{ onFailure: (err) => reportFailure("push", err) },
	);

	const pull = async (): Promise<void> => {
		if (disposed || !guardOnline()) return;
		await pullTask.run();
	};

	const push = async (): Promise<void> => {
		if (disposed || !guardOnline() || ops.push === undefined) return;
		await pushTask.run();
	};

	// A push includes a pull; without changes to push, pull (and push anything the pull
	// brought in, e.g. imported data).
	const syncTask = createSerialTask(async () => {
		if (disposed || !guardOnline()) return;
		await ops.load();
		if (ops.push === undefined || ops.pendingCount() === 0) await pull();
		await push();
		events.emit("sync:success", { direction: "full" });
	});

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

	// A push already running is waited for too, so closing doesn't cut it off.
	const flush = (): Promise<void> => {
		if (isPushScheduled()) return runScheduledPush();
		if (pushTask.running) return push().catch(() => {});
		return Promise.resolve();
	};

	// Flush a scheduled push when the page is hidden or closed, so a quick edit-then-close
	// still reaches the remote. Best effort: if the browser kills the request, the change is
	// still pending in storage and is pushed on the next sync.
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

	const stopWatching = ops.watch((pushNeeded) => {
		updatePending();
		if (started && pushNeeded && ops.push !== undefined && guardOnline()) {
			schedulePush();
		}
	});

	// Once loaded, changes stored offline earlier are already pending; refresh the count.
	void ops.load().then(
		() => {
			if (!disposed) updatePending();
		},
		() => {}, // load failures surface through pull/push (which retry the load)
	);

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
			ops.setFilter?.(next);
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
			stopWatching();
			networkSub?.();
		},
	};
}
