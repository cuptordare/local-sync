import type { EventMap, Listener, Unsubscribe } from "./event-types.js";

type EmitArgs<
	Events extends EventMap,
	K extends keyof Events,
> = Events[K] extends void ? [] : [payload: Events[K]];

/** A tiny, synchronous event emitter. */
export interface EventBus<Events extends EventMap> {
	on<K extends keyof Events>(
		event: K,
		listener: Listener<Events[K]>,
	): Unsubscribe;
	once<K extends keyof Events>(
		event: K,
		listener: Listener<Events[K]>,
	): Unsubscribe;
	off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void;
	emit<K extends keyof Events>(event: K, ...args: EmitArgs<Events, K>): void;
	clear(type?: keyof Events): void;
	listenerCount(type?: keyof Events): number;
}

type AnyListener = (payload: unknown) => void;

export function createEventBus<Events extends EventMap>(): EventBus<Events> {
	const registry = new Map<keyof Events, Set<AnyListener>>();

	const add = (type: keyof Events, listener: AnyListener): void => {
		let listeners = registry.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			registry.set(type, listeners);
		}
		listeners.add(listener);
	};

	const remove = (type: keyof Events, listener: AnyListener): void => {
		const listeners = registry.get(type);
		if (listeners === undefined) return;
		listeners.delete(listener);
		if (listeners.size === 0) registry.delete(type);
	};

	return {
		on(type, listener) {
			const wrapped = listener as AnyListener;
			add(type, wrapped);
			return () => remove(type, wrapped);
		},

		once(type, listener) {
			const wrapped: AnyListener = (payload) => {
				remove(type, wrapped);
				(listener as AnyListener)(payload);
			};
			add(type, wrapped);
			return () => remove(type, wrapped);
		},

		off(type, listener) {
			remove(type, listener as AnyListener);
		},

		emit(type, ...args) {
			const listeners = registry.get(type);
			if (listeners === undefined || listeners.size === 0) return;
			const payload = args[0] as unknown;
			// Snapshot so mutations during dispatch don't affect this emission.
			for (const listener of [...listeners]) {
				listener(payload);
			}
		},

		clear(type) {
			if (type === undefined) {
				registry.clear();
			} else {
				registry.delete(type);
			}
		},

		listenerCount(type) {
			if (type === undefined) {
				let count = 0;
				for (const listeners of registry.values()) {
					count += listeners.size;
				}
				return count;
			} else {
				const listeners = registry.get(type);
				return listeners === undefined ? 0 : listeners.size;
			}
		},
	};
}
