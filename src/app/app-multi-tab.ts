/**
 * Keeps several open tabs of one app consistent (internal; enabled by createLocalSyncApp).
 *
 * Without this, each tab keeps its own in-memory copy of shared storage: an edit in one tab
 * doesn't show in the others, a stale tab can write old data back, and every tab polls the
 * remote. With it:
 *   - After a tab's write lands in storage, it announces the record ids; other tabs re-read
 *     just those records from storage (storage stays the single source of truth, so tabs
 *     converge regardless of message order).
 *   - Only one tab (the leader) runs automatic sync. The others show the leader's sync
 *     status. Manual syncs still work from any tab (pushes are idempotent and
 *     version-checked, so an overlap is harmless). The leader shares which collections it
 *     syncs; a follower syncs a collection only its own page uses until the leader has it too.
 *   - Sync bookkeeping writes (acks, remote data) re-check the stored copy first, so a tab
 *     never overwrites another tab's newer write with a result based on an outdated copy.
 *   - Filter changes on a read-only source are shared, so the leader's refreshes keep
 *     fetching what the tabs are actually showing.
 *
 * Leader election uses the browser's Web Locks API: the first tab gets the lock immediately,
 * and when it closes (or crashes) the browser hands the lock to the next tab -- no delay, no
 * timers. A tab keeps leading until it closes. Without Web Locks or BroadcastChannel,
 * multi-tab is off.
 */
import type { TabChannel } from "../network/multi-tab-sync.js";
import { createBroadcastChannelTab } from "../network/multi-tab-sync.js";
import type { AppSyncState } from "./app-status.js";

/** The part of the Web Locks API's `LockManager` (`navigator.locks`) used for leader election. */
export interface TabLocks {
	request(name: string, callback: () => Promise<void>): Promise<unknown>;
}

export interface MultiTabOptions {
	/** Transport between tabs. Defaults to a BroadcastChannel named after the app. */
	channel?: TabChannel;
	/** Lock manager for leader election. Defaults to `navigator.locks`. */
	locks?: TabLocks;
}

type Message =
	| { type: "changed"; collection: string; ids: string[] }
	| { type: "status"; state: AppSyncState }
	| { type: "status-request" }
	| { type: "filter"; collection: string; filter: unknown }
	| { type: "collections"; names: string[] };

export interface AppMultiTabHandlers {
	/** Another tab persisted these records: re-read them from storage. */
	onChanged(collection: string, ids: readonly string[]): void;
	/** The leader's sync status (undefined when this tab becomes the leader). */
	onLeaderStatus(state: AppSyncState | undefined): void;
	/** This tab now runs automatic sync (until it closes). */
	onBecameLeader(): void;
	/** Another tab changed a source's filter. */
	onFilter(collection: string, filter: unknown): void;
	/** The collections the leader tab syncs (a follower syncs any others it has itself). */
	onLeaderCollections(names: readonly string[]): void;
}

export interface AppMultiTab {
	/** This tab runs automatic sync. */
	isLeader(): boolean;
	announceChanged(collection: string, ids: readonly string[]): void;
	announceFilter(collection: string, filter: unknown): void;
	/** Share this tab's sync status (only sent while leader). */
	publishStatus(state: AppSyncState): void;
	/** Share which collections this tab syncs (only sent while leader). */
	publishCollections(names: readonly string[]): void;
	dispose(): void;
}

/** Returns undefined (multi-tab off) when Web Locks or BroadcastChannel is unavailable. */
export function createAppMultiTab(
	appName: string,
	options: MultiTabOptions,
	handlers: AppMultiTabHandlers,
): AppMultiTab | undefined {
	const locks =
		options.locks ??
		(typeof navigator !== "undefined" ? navigator.locks : undefined);
	if (locks === undefined) return undefined;
	if (
		options.channel === undefined &&
		typeof BroadcastChannel === "undefined"
	) {
		return undefined;
	}
	const channel =
		options.channel ?? createBroadcastChannelTab(`localsync:${appName}`);
	let leader = false;
	let lastStatus: AppSyncState | undefined;
	let lastCollections: string[] = [];
	let releaseLock: (() => void) | undefined;
	let disposed = false;
	// Writes still landing after the app closed must not post to the closed channel.
	const post = (message: Message): void => {
		if (!disposed) channel.post(message);
	};

	const stopMessages = channel.subscribe((raw) => {
		const message = raw as Message;
		switch (message.type) {
			case "changed":
				handlers.onChanged(message.collection, message.ids);
				break;
			case "status":
				if (!leader) handlers.onLeaderStatus(message.state);
				break;
			case "status-request":
				if (leader && lastStatus !== undefined) {
					post({ type: "status", state: lastStatus });
				}
				if (leader) post({ type: "collections", names: lastCollections });
				break;
			case "filter":
				handlers.onFilter(message.collection, message.filter);
				break;
			case "collections":
				if (!leader) handlers.onLeaderCollections(message.names);
				break;
		}
	});

	post({ type: "status-request" }); // until we lead, show the leader's status
	locks
		.request(
			`localsync:${appName}:leader`,
			() =>
				new Promise<void>((resolve) => {
					releaseLock = resolve; // held until this tab closes
					if (disposed) {
						resolve();
						return;
					}
					leader = true;
					handlers.onLeaderStatus(undefined);
					if (lastStatus !== undefined) {
						post({ type: "status", state: lastStatus });
					}
					handlers.onBecameLeader();
				}),
		)
		.catch(() => {});

	return {
		isLeader: () => leader,
		announceChanged(collection, ids) {
			post({ type: "changed", collection, ids: [...ids] });
		},
		announceFilter(collection, filter) {
			post({ type: "filter", collection, filter });
		},
		publishStatus(state) {
			lastStatus = state;
			if (leader) post({ type: "status", state });
		},
		publishCollections(names) {
			lastCollections = [...names];
			if (leader) post({ type: "collections", names: lastCollections });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopMessages();
			releaseLock?.(); // the next tab in line takes over right away
			channel.close();
		},
	};
}
