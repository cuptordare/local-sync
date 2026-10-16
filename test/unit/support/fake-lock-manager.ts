import type { TabLocks } from "../../../src/app/app-multi-tab.js";

/**
 * An in-memory stand-in for `navigator.locks`, shared by simulated tabs. Each lock name is
 * granted to one holder at a time, in request order; when the holder's callback settles, the
 * next waiter gets it.
 */
export function createFakeLockManager(): TabLocks {
	const queues = new Map<string, Array<() => void>>();
	return {
		request(name, callback) {
			let queue = queues.get(name);
			if (queue === undefined) {
				queue = [];
				queues.set(name, queue);
			}
			const waiters = queue;
			return new Promise((resolve, reject) => {
				const grant = (): void => {
					// Granted asynchronously, as the real API does.
					Promise.resolve()
						.then(callback)
						.then(resolve, reject)
						.finally(() => {
							waiters.shift();
							waiters[0]?.();
						});
				};
				waiters.push(grant);
				if (waiters.length === 1) grant();
			});
		},
	};
}
