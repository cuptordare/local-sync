/**
 * Reactive sync state -- what the UI binds to show "Syncing...", "Offline",
 * error banners, or a pending-changes badge. Built on the reactive store with
 * deepEqual, so subscribers only get notified when the state actually changes.
 */

import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveStore } from "../reactivity/reactive-store.js";
import { deepEqual } from "../utils/deep-equal.js";

export type SyncPhase = "idle" | "syncing" | "error";

export interface SyncState {
	/** What the engine is doing right now. */
	phase: SyncPhase;
	/** Whether we believe we have connectivity. */
	online: boolean;
	/** Number of local changes waiting to be pushed. */
	pending: number;
	/** Epoch ms of the last successful sync, if any. */
	lastSyncedAt: number | undefined;
	/** Wall-clock duration of the last successful sync, if any. */
	lastSyncDurationMs: number | undefined;
	/** Last error message, if any. */
	lastError: string | undefined;
}

export interface SyncStatus {
	get(): SyncState;
	/** Merge a partial update into the state. */
	patch(partial: Partial<SyncState>): void;
	subscribe(listener: Listener<SyncState>): Unsubscribe;
	query(): ReactiveQuery<SyncState>;
}

export function createSyncStatus(initial: Partial<SyncState> = {}): SyncStatus {
	const store = createReactiveStore<SyncState>(
		{
			phase: "idle",
			online: true,
			pending: 0,
			lastSyncedAt: undefined,
			lastSyncDurationMs: undefined,
			lastError: undefined,
			...initial,
		},
		{
			equals: deepEqual,
		},
	);

	return {
		get: () => store.get(),
		patch: (partial) => store.update((current) => ({ ...current, ...partial })),
		subscribe: (listener) => store.subscribe(listener),
		query: () =>
			createReactiveQuery<SyncState>({
				compute: () => store.get(),
				subscribeToSources: (onChange) => store.subscribe(() => onChange()),
			}),
	};
}
