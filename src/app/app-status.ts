/**
 * One sync status for the whole app, derived from every app-managed engine -- what a single
 * "Saving... / Offline / Couldn't sync" badge binds to, instead of each app hand-aggregating
 * per-collection engines.
 */
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { NetworkStatus } from "../network/network-status.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveQuery } from "../reactivity/reactive-query.js";
import type { ReactiveStore } from "../reactivity/reactive-store.js";
import { createReactiveStore } from "../reactivity/reactive-store.js";
import type { SyncEngine } from "../sync/sync-engine.js";
import type { SyncPhase } from "../sync/sync-status.js";
import { deepEqual } from "../utils/deep-equal.js";

export interface AppSyncState {
	/** `"error"` if any collection's last sync failed, else `"syncing"` if any is syncing, else `"idle"`. */
	phase: SyncPhase;
	/** Whether we believe we have connectivity. */
	online: boolean;
	/** Local changes not yet pushed, across all collections. */
	pending: number;
	/** A debounced push is scheduled somewhere (changes are about to be saved). */
	pushScheduled: boolean;
	/** When every collection had last synced successfully (the oldest of them); undefined until all have. */
	lastSyncedAt: number | undefined;
	/** The first failing collection's error, prefixed with its name. */
	lastError: string | undefined;
}

export interface AppSyncStatus {
	get(): AppSyncState;
	/** Notified only when the derived state actually changes. Does not fire immediately. */
	subscribe(listener: Listener<AppSyncState>): Unsubscribe;
	query(): ReactiveQuery<AppSyncState>;
}

export interface AppSyncStatusController extends AppSyncStatus {
	track(name: string, engine: SyncEngine<never>): void;
	/** This tab's own engines' state (what a leader tab shares with the others). */
	readonly local: AppSyncStatus;
	/**
	 * Show another tab's state instead of this tab's (a follower tab, whose engines are idle,
	 * shows the leader's). `undefined` goes back to this tab's own state.
	 */
	setOverride(state: AppSyncState | undefined): void;
	dispose(): void;
}

const PHASE_RANK: Record<SyncPhase, number> = { idle: 0, syncing: 1, error: 2 };

export function createAppSyncStatus(
	getNetwork: () => NetworkStatus | undefined,
): AppSyncStatusController {
	const engines = new Map<string, SyncEngine<never>>();
	const subscriptions: Unsubscribe[] = [];
	let networkSub: Unsubscribe | undefined;

	const compute = (): AppSyncState => {
		const state: AppSyncState = {
			phase: "idle",
			online: getNetwork()?.isOnline() ?? true,
			pending: 0,
			pushScheduled: false,
			lastSyncedAt: undefined,
			lastError: undefined,
		};
		let allSynced = engines.size > 0;
		let oldest = Number.POSITIVE_INFINITY;
		for (const [name, engine] of engines) {
			const s = engine.getState();
			if (PHASE_RANK[s.phase] > PHASE_RANK[state.phase]) state.phase = s.phase;
			state.pending += s.pending;
			state.pushScheduled ||= s.pushScheduled;
			if (s.lastError !== undefined && state.lastError === undefined) {
				state.lastError = `${name}: ${s.lastError}`;
			}
			if (s.lastSyncedAt === undefined) allSynced = false;
			else oldest = Math.min(oldest, s.lastSyncedAt);
		}
		if (allSynced) state.lastSyncedAt = oldest;
		return state;
	};

	const view = (store: ReactiveStore<AppSyncState>): AppSyncStatus => ({
		get: () => store.get(),
		subscribe: (listener) => store.subscribe(listener),
		query: () =>
			createReactiveQuery({
				compute: () => store.get(),
				subscribeToSources: (onChange) => store.subscribe(() => onChange()),
			}),
	});

	const local = createReactiveStore<AppSyncState>(compute(), {
		equals: deepEqual,
	});
	const shown = createReactiveStore<AppSyncState>(local.get(), {
		equals: deepEqual,
	});
	let override: AppSyncState | undefined;
	const refresh = () => {
		local.set(compute());
		// Connectivity is always this tab's own; everything else may come from the leader.
		shown.set(
			override === undefined
				? local.get()
				: { ...override, online: local.get().online },
		);
	};

	return {
		...view(shown),
		local: view(local),
		setOverride(state) {
			override = state;
			refresh();
		},
		track(name, engine) {
			engines.set(name, engine);
			subscriptions.push(engine.status.subscribe(refresh));
			if (networkSub === undefined) {
				networkSub = getNetwork()?.subscribe(refresh);
			}
			refresh();
		},
		dispose() {
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			networkSub?.();
			engines.clear();
		},
	};
}
