import type { NetworkStatus } from "../../../src/network/network-status.js";
import { createReactiveQuery } from "../../../src/reactivity/reactive-query.js";
import { createReactiveStore } from "../../../src/reactivity/reactive-store.js";

/** A manually-settable NetworkStatus double, for offline-gating tests without real `window` events. */
export function createFakeNetworkStatus(initialOnline = true): NetworkStatus {
	const store = createReactiveStore<boolean>(initialOnline);
	return {
		isOnline: () => store.get(),
		set: (online) => store.set(online),
		subscribe: (listener) => store.subscribe(listener),
		query: () =>
			createReactiveQuery({
				compute: () => store.get(),
				subscribeToSources: (onChange) => store.subscribe(() => onChange()),
			}),
		dispose: () => {},
	};
}
