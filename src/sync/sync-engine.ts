/**
 * The `SyncEngine` shape (the orchestration contract). The implementation that
 * builds one lives in `create-sync-engine.ts`.
 */
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { SyncEventMap } from "./sync-events.js";
import type { SyncState, SyncStatus } from "./sync-status.js";

/** Default delay for `pushOnChange`, so a burst of edits becomes one push. */
export const DEFAULT_PUSH_DEBOUNCE_MS = 500;

export interface PushOnChangeOptions {
	/**
	 * Wait this long after the last local change before pushing (trailing debounce).
	 * Default 500ms. `0` pushes in a microtask (changes made in the same tick still batch).
	 */
	debounceMs?: number;
	/**
	 * Push at most this long after the first change of a burst, even if edits keep coming
	 * (so continuous typing can't postpone saving forever). Default 10x `debounceMs`.
	 */
	maxWaitMs?: number;
}

export interface SyncStartOptions {
	/** Run a full sync on this interval. Omit for no periodic sync. */
	intervalMs?: number;
	/**
	 * Push automatically after local changes. `true` uses the default debounce (500ms).
	 * Only local edits schedule a push -- applying remote data or acks never does. A pending
	 * push is flushed when the page is hidden or closed (best effort; un-pushed changes stay
	 * dirty in storage and are pushed on the next sync regardless). Default false.
	 */
	pushOnChange?: boolean | PushOnChangeOptions;
	/** Run one full sync immediately when starting. Default true. */
	syncOnStart?: boolean;
}

export interface SyncEngine<Filter = unknown> {
	/** Reactive sync state (bind this into your UI). */
	readonly status: SyncStatus;
	/** Current state snapshot. */
	getState(): SyncState;
	/** Pull remote changes and merge them into the local state. */
	pull(): Promise<void>;
	/** Push pending local changes to the remote (no-op for pull-only adapters). */
	push(): Promise<void>;
	/** Push then pull. */
	sync(): Promise<void>;
	/**
	 * Run a scheduled (debounced) push now, if one is scheduled; resolves once it (and any push
	 * already running) has finished, so its result has been applied. Never rejects.
	 */
	flush(): Promise<void>;
	/**
	 * Change the pull filter (resets the incremental cursor). A pull already running for the
	 * old filter discards its results and is followed by one for the new filter.
	 */
	setFilter(filter: Filter): void;
	/** Begin auto-sync behaviors (interval / push-on-change / sync-on-start). */
	start(options?: SyncStartOptions): void;
	/** Stop auto-sync behaviors. */
	stop(): void;
	/** Subscribe to sync lifecycle events. */
	on<K extends keyof SyncEventMap>(
		event: K,
		listener: Listener<SyncEventMap[K]>,
	): Unsubscribe;
	/** Stop everything and clean up resources. */
	dispose(): void;
}
