/**
 * The `SyncEngine` shape (the orchestration contract). The implementation that
 * builds one lives in `create-sync-engine.ts`.
 */
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { SyncEventMap } from "./sync-events.js";
import type { SyncState, SyncStatus } from "./sync-status.js";

export interface SyncStartOptions {
	/** Run a full sync on this interval. Omit for no periodic sync. */
	intervalMs?: number;
	/** Push automatically whenever local data changes. Default false. */
	pushOnChange?: boolean;
	/** Run one full sync immediately when starting. Default false. */
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
	/** Change the pull filter (resets the incremental cursor). */
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
