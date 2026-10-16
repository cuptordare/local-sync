/**
 * A pipe between open tabs of one app: the browser's `BroadcastChannel`, or an in-memory hub
 * that connects "tabs" within one process (for tests and simulations). The app sends entries
 * through it (see app/app-multi-tab.ts); since every tab merges what it receives, messages
 * may arrive late or out of order.
 */
import type { Unsubscribe } from "../events/event-types.js";

/** A pipe between tabs. `post` sends to OTHER tabs (never echoes to the sender). */
export interface TabChannel {
	post(message: unknown): void;
	subscribe(listener: (message: unknown) => void): Unsubscribe;
	close(): void;
}

/** Build a `TabChannel` from the browser `BroadcastChannel` API (real multi-tab). */
export function createBroadcastChannelTab(name: string): TabChannel {
	const channel = new BroadcastChannel(name);
	const listeners = new Set<(message: unknown) => void>();
	channel.onmessage = (event: MessageEvent) => {
		for (const listener of [...listeners]) listener(event.data);
	};
	return {
		post: (message) => channel.postMessage(message),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close: () => {
			channel.onmessage = null;
			channel.close();
		},
	};
}

/** Connects multiple `TabChannel`s within ONE process — for tests/simulations only. */
export interface InMemoryChannelHub {
	connect(): TabChannel;
}

/**
 * Simulate several tabs in a single JS process. Each `connect()` is like opening a
 * new tab; `post` delivers to all OTHER connections (matching real BroadcastChannel,
 * which never echoes to the sender). Messages are structured-cloned, as real ones are.
 */
export function createInMemoryChannelHub(): InMemoryChannelHub {
	interface Connection {
		listeners: Set<(message: unknown) => void>;
	}
	const connections = new Set<Connection>();

	return {
		connect(): TabChannel {
			const connection: Connection = { listeners: new Set() };
			connections.add(connection);
			let closed = false;
			return {
				post(message) {
					if (closed) return; // a closed channel can neither send nor receive
					const copy = structuredClone(message);
					for (const other of connections) {
						if (other === connection) continue; // sender never receives its own message
						for (const listener of [...other.listeners])
							listener(structuredClone(copy));
					}
				},
				subscribe(listener) {
					connection.listeners.add(listener);
					return () => {
						connection.listeners.delete(listener);
					};
				},
				close() {
					closed = true;
					connections.delete(connection);
					connection.listeners.clear();
				},
			};
		},
	};
}
