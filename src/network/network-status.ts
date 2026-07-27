/**
 * Tracks whether the app currently has network connectivity, as a reactive value.
 *
 * REAL-WORLD: a user on a train opens the app. Their phone drops off wifi in a
 * tunnel. You want two things to happen automatically:
 *   1. The UI shows an "Offline - changes will sync later" banner.
 *   2. The sync engine STOPS trying to push/pull and resumes when back.
 * Both just subscribe to this. In the browser it listens to the `online`/`offline`
 * window events; in Node/tests there are no such events, so it defaults to online
 * and you can drive it manually with `set()`.
 *
 * @example
 *   const net = createNetworkStatus();
 *   net.subscribe((online) => banner.hidden = online);
 *   if (!net.isOnline()) showOfflineBanner();
 *   // ...if a fetch fails even though the browser says online:
 *   net.set(false); // force offline state
 */

import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveStore } from "../reactivity/reactive-store.js";

export interface NetworkStatus {
	/** Current connectivity status. */
	isOnline(): boolean;
	/** Force the state (e.g. you detected a dead connection from a failed request). */
	set(online: boolean): void;
	/** Subscribe to connectivity changes. */
	subscribe(listener: Listener<boolean>): Unsubscribe;
	/** Get a reactive query for the connectivity status (for binding into a framework). */
	query(): ReactiveQuery<boolean>;
	/** Stop listening to browser events. */
	dispose(): void;
}

export interface NetworkStatusOptions {
	/** Starting state. Defaults to `navigator.onLine` when available, else `true`. */
	initialStatus?: boolean;
	/**
	 * How to observe connectivity changes. Defaults to using the `online` and `offline`
	 * events on `window`. Override to plug in a custom connectivity source.
	 */
	watch?: (set: (online: boolean) => void) => Unsubscribe;
}

function detectInitialOnline(): boolean {
	if (
		typeof navigator !== "undefined" &&
		typeof navigator.onLine === "boolean"
	) {
		return navigator.onLine;
	}
	return true; // Node -- no browser: assume online
}

function defaultWatch(set: (online: boolean) => void): Unsubscribe {
	// No window (Node, workers without it) -> nothing to listen to.
	if (
		typeof window === "undefined" ||
		typeof window.addEventListener !== "function"
	) {
		return () => {};
	}
	const onlineHandler = () => set(true);
	const offlineHandler = () => set(false);
	window.addEventListener("online", onlineHandler);
	window.addEventListener("offline", offlineHandler);
	return () => {
		window.removeEventListener("online", onlineHandler);
		window.removeEventListener("offline", offlineHandler);
	};
}

export function createNetworkStatus(
	options: NetworkStatusOptions = {},
): NetworkStatus {
	const store = createReactiveStore<boolean>(
		options.initialStatus ?? detectInitialOnline(),
	);
	const set = (online: boolean) => store.set(online);
	const watch = options.watch ?? defaultWatch;
	const stopWatching = watch(set);
	return {
		isOnline: () => store.get(),
		set,
		subscribe: (listener) => store.subscribe(listener),
		query: () =>
			createReactiveQuery({
				compute: () => store.get(),
				subscribeToSources: (onChange) => store.subscribe(() => onChange()),
			}),
		dispose: () => stopWatching(),
	};
}
