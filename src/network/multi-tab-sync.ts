/**
 * Keep browser tabs in agreement.
 *
 * THE PROBLEM (concrete):
 * A user opens your app in THREE browser tabs. Each tab is a separate JavaScript
 * program with its OWN in-memory copy of the data. So:
 *   • They add a todo in Tab A. Tabs B and C still show the old list — they have no
 *     idea anything changed until the user reloads them. That feels broken.
 *   • Worse, if all three tabs independently sync with your server, you get 3× the
 *     network traffic, and three tabs racing to push the same change can conflict.
 *
 * THIS FILE SOLVES TWO THINGS using the browser's `BroadcastChannel` API — a simple
 * "party line" that lets same-origin tabs/windows send each other messages:
 *
 *   1. CROSS-TAB MESSAGES (`broadcast` / `onBroadcast`)
 *      When Tab A changes data, it shouts the change to the other tabs so they can
 *      update their in-memory copy instantly — no server round-trip, no reload.
 *      (The collection/sync layer decides WHAT to broadcast; this file is the pipe.)
 *
 *   2. LEADER ELECTION (`isLeader` / `onLeadershipChange`)
 *      The tabs agree on ONE "leader" tab that is allowed to talk to the server.
 *      Followers stay quiet and rely on the leader + cross-tab messages. If the
 *      leader tab is closed or crashes, the others notice and elect a new leader.
 *      Result: one network connection for the whole app, no duplicate/conflicting
 *      syncs.
 *
 * HOW LEADER ELECTION WORKS HERE (kept deliberately simple/understandable):
 *   • Every tab has a unique id and a `startedAt` timestamp.
 *   • The LEADER is simply the OLDEST tab (smallest `startedAt`; ties broken by id).
 *     Every tab can compute this independently from the set of tabs it knows about.
 *   • Tabs announce themselves on startup and send periodic "heartbeats". Presence is
 *     tracked in HEARTBEAT TICKS, not wall-clock time: each tick, every known peer's
 *     "missed" counter goes up; hearing from a peer resets it to 0. Miss too many in
 *     a row → that peer is presumed gone (closed/crashed) and dropped, triggering a
 *     re-election. A clean close also sends a "bye" for instant hand-off.
 *   This is eventually-consistent (brief overlap is possible right after a crash).
 *   For stricter guarantees the browser `navigator.locks` API is an alternative; we
 *   chose the simpler, dependency-free, fully-testable approach.
 *
 * TESTABILITY: the transport is abstracted as `TabChannel`. In the browser you build
 * one from `BroadcastChannel`; in tests you use an in-memory hub that wires several
 * channels together in one process to simulate multiple tabs.
 *
 * @example
 *   const sync = createMultiTabSync<{ type: "todos:changed", ids: string[] }>({
 *     channelName: "localsyncexample",
 *   });
 *
 *   sync.onBroadcast((message, fromTabId) => {
 *     if (message.type === "todos:changed") console.log("Apply update from", fromTabId, message.ids);
 *   });
 *
 *   sync.broadcast({ type: "todos:changed", ids: ["abc", "def"] });
 *   sync.dispose(); // cleanly leave the party line when this tab is closed
 */

import type { Listener, Unsubscribe } from "../events/event-types.js";
import { createId } from "../utils/ids.js";
import { now as defaultNow } from "../utils/timestamps.js";

// ===========================================================================
// Transport abstraction
// ===========================================================================

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

// ===========================================================================
// Wire protocol (internal control messages + app messages)
// ===========================================================================

type ControlMessage =
	| { kind: "announce"; tabId: string; startedAt: number }
	| { kind: "heartbeat"; tabId: string; startedAt: number }
	| { kind: "bye"; tabId: string }
	| { kind: "app"; tabId: string; payload: unknown };

function isControlMessage(message: unknown): message is ControlMessage {
	if (typeof message !== "object" || message === null) return false;
	const kind = (message as { kind?: unknown }).kind;
	return (
		kind === "announce" ||
		kind === "heartbeat" ||
		kind === "bye" ||
		kind === "app"
	);
}

// ===========================================================================
// MultiTabSync
// ===========================================================================

export interface MultiTabSyncOptions<_M> {
	/** The transport. Defaults to a BroadcastChannel named `channelName`. */
	channel?: TabChannel;
	/** Channel name used when `channel` is not supplied. Defaults to `"localsync"`. */
	channelName?: string;
	/** This tab's id. Defaults to a generated id. */
	tabId?: string;
	/** This tab's age marker; smaller = older = preferred leader. Defaults to `now()`. */
	startedAt?: number;
	/** Clock used for the default `startedAt`. */
	now?: () => number;
	/** Heartbeat period in ms. Defaults to 2000. */
	heartbeatIntervalMs?: number;
	/** Consecutive missed heartbeats before a peer is presumed gone. Defaults to 3. */
	maxMissedHeartbeats?: number;
}

export interface MultiTabSync<M> {
	readonly tabId: string;
	/** Is this tab currently the leader (the one allowed to talk to the server)? */
	isLeader(): boolean;
	/** Notified (with the new value) whenever this tab gains/loses leadership. */
	onLeadershipChange(listener: Listener<boolean>): Unsubscribe;
	/** Send an application message to the other tabs (e.g. "todos changed"). */
	broadcast(message: M): void;
	/** Receive application messages from other tabs (with the sender's tab id). */
	onBroadcast(listener: (message: M, fromTabId: string) => void): Unsubscribe;
	/** Cleanly leave: tell peers, stop heartbeats, close the channel. */
	dispose(): void;
}

interface PeerInfo {
	startedAt: number;
	missed: number;
}

export function createMultiTabSync<M = unknown>(
	options: MultiTabSyncOptions<M> = {},
): MultiTabSync<M> {
	const tabId = options.tabId ?? createId("tab");
	const startedAt = options.startedAt ?? (options.now ?? defaultNow)();
	const channel =
		options.channel ??
		createBroadcastChannelTab(options.channelName ?? "localsync");
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 2000;
	const maxMissed = options.maxMissedHeartbeats ?? 3;

	// Known tabs, including ourselves. Ourselves never goes stale.
	const peers = new Map<string, PeerInfo>([[tabId, { startedAt, missed: 0 }]]);
	const leadershipListeners = new Set<Listener<boolean>>();
	const appListeners = new Set<(message: M, fromTabId: string) => void>();

	let leaderId = tabId;
	let wasLeader = true; // alone at first, so we start as leader
	let disposed = false;

	const postControl = (message: ControlMessage): void => channel.post(message);

	const recomputeLeader = (): void => {
		// Leader = oldest tab (smallest startedAt), ties broken by smallest id.
		let bestId = tabId;
		let bestStartedAt = Number.POSITIVE_INFINITY;
		for (const [id, info] of peers) {
			if (
				info.startedAt < bestStartedAt ||
				(info.startedAt === bestStartedAt && id < bestId)
			) {
				bestId = id;
				bestStartedAt = info.startedAt;
			}
		}
		leaderId = bestId;

		const isNowLeader = leaderId === tabId;
		if (isNowLeader !== wasLeader) {
			wasLeader = isNowLeader;
			for (const listener of [...leadershipListeners]) listener(isNowLeader);
		}
	};

	const onMessage = (raw: unknown): void => {
		if (!isControlMessage(raw)) return;
		if (raw.tabId === tabId) return; // ignore our own echoes (shouldn't happen)

		switch (raw.kind) {
			case "announce":
				peers.set(raw.tabId, { startedAt: raw.startedAt, missed: 0 });
				// Reply so the newcomer immediately learns WE exist (snappy discovery).
				postControl({ kind: "heartbeat", tabId, startedAt });
				recomputeLeader();
				break;
			case "heartbeat":
				peers.set(raw.tabId, { startedAt: raw.startedAt, missed: 0 });
				recomputeLeader();
				break;
			case "bye":
				peers.delete(raw.tabId);
				recomputeLeader();
				break;
			case "app":
				for (const listener of [...appListeners])
					listener(raw.payload as M, raw.tabId);
				break;
		}
	};

	const heartbeatTick = (): void => {
		// Age every other known peer; we'll hear from the live ones and reset them.
		for (const [id, info] of peers) {
			if (id !== tabId) info.missed += 1;
		}
		postControl({ kind: "heartbeat", tabId, startedAt });
		// Drop peers we haven't heard from in too long (closed/crashed tabs).
		for (const [id, info] of [...peers]) {
			if (id !== tabId && info.missed > maxMissed) peers.delete(id);
		}
		recomputeLeader();
	};

	const unsubscribe = channel.subscribe(onMessage);
	postControl({ kind: "announce", tabId, startedAt });
	const timer = setInterval(heartbeatTick, heartbeatIntervalMs);

	return {
		tabId,
		isLeader: () => leaderId === tabId,
		onLeadershipChange(listener) {
			leadershipListeners.add(listener);
			return () => {
				leadershipListeners.delete(listener);
			};
		},
		broadcast(message) {
			postControl({ kind: "app", tabId, payload: message });
		},
		onBroadcast(listener) {
			appListeners.add(listener);
			return () => {
				appListeners.delete(listener);
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(timer);
			postControl({ kind: "bye", tabId });
			unsubscribe();
			channel.close();
		},
	};
}
