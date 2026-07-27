import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createInMemoryChannelHub,
	createMultiTabSync,
} from "../../../src/network/multi-tab-sync.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createMultiTabSync: leader election", () => {
	it("a solo tab is its own leader immediately", () => {
		const hub = createInMemoryChannelHub();
		const tab = createMultiTabSync({ channel: hub.connect() });
		assert.equal(tab.isLeader(), true);
		tab.dispose();
	});

	it("the oldest tab (smallest startedAt) is the leader", () => {
		const hub = createInMemoryChannelHub();
		const tab1 = createMultiTabSync({
			channel: hub.connect(),
			startedAt: 100,
			tabId: "t1",
		});
		const tab2 = createMultiTabSync({
			channel: hub.connect(),
			startedAt: 200,
			tabId: "t2",
		});
		assert.equal(tab1.isLeader(), true);
		assert.equal(tab2.isLeader(), false);
		tab1.dispose();
		tab2.dispose();
	});

	it("ties on startedAt are broken by the smaller tabId", () => {
		const hub = createInMemoryChannelHub();
		// Construct "b" first, "a" second -- creation order must not matter, only id.
		const tabB = createMultiTabSync({
			channel: hub.connect(),
			startedAt: 100,
			tabId: "b",
		});
		const tabA = createMultiTabSync({
			channel: hub.connect(),
			startedAt: 100,
			tabId: "a",
		});
		assert.equal(tabA.isLeader(), true);
		assert.equal(tabB.isLeader(), false);
		tabA.dispose();
		tabB.dispose();
	});

	it("dispose() sends an immediate 'bye', triggering instant re-election", () => {
		const hub = createInMemoryChannelHub();
		const tab1 = createMultiTabSync({
			channel: hub.connect(),
			startedAt: 100,
			tabId: "t1",
		});
		const tab2 = createMultiTabSync({
			channel: hub.connect(),
			startedAt: 200,
			tabId: "t2",
		});
		assert.equal(tab2.isLeader(), false);

		const changes: boolean[] = [];
		tab2.onLeadershipChange((isLeader) => changes.push(isLeader));

		tab1.dispose();
		assert.equal(tab2.isLeader(), true);
		assert.deepEqual(changes, [true]);
		tab2.dispose();
	});

	it("a tab that goes silent without a 'bye' is dropped after missed heartbeats", async () => {
		const hub = createInMemoryChannelHub();
		const rawChannel1 = hub.connect();
		const tab1 = createMultiTabSync({
			channel: rawChannel1,
			startedAt: 100,
			tabId: "t1",
			heartbeatIntervalMs: 500, // won't matter -- we kill it before its next tick
		});
		const tab2 = createMultiTabSync({
			channel: hub.connect(),
			startedAt: 200,
			tabId: "t2",
			heartbeatIntervalMs: 15,
			maxMissedHeartbeats: 1,
		});
		assert.equal(tab2.isLeader(), false);

		const changes: boolean[] = [];
		tab2.onLeadershipChange((isLeader) => changes.push(isLeader));

		// Simulate a crash: close the transport directly, bypassing dispose() (no "bye" sent).
		rawChannel1.close();

		await wait(150);
		assert.equal(tab2.isLeader(), true);
		assert.deepEqual(changes, [true]);
		tab2.dispose();
		tab1.dispose(); // clears tab1's own heartbeat timer, even though its channel is already closed
	});
});

describe("createMultiTabSync: broadcast", () => {
	it("delivers app messages to other tabs with the sender's tab id", () => {
		const hub = createInMemoryChannelHub();
		const tab1 = createMultiTabSync<{ text: string }>({
			channel: hub.connect(),
			tabId: "t1",
		});
		const tab2 = createMultiTabSync<{ text: string }>({
			channel: hub.connect(),
			tabId: "t2",
		});

		const received: Array<{ message: { text: string }; from: string }> = [];
		tab2.onBroadcast((message, fromTabId) =>
			received.push({ message, from: fromTabId }),
		);

		tab1.broadcast({ text: "hello" });
		assert.deepEqual(received, [{ message: { text: "hello" }, from: "t1" }]);
		tab1.dispose();
		tab2.dispose();
	});

	it("the sender never receives its own broadcast", () => {
		const hub = createInMemoryChannelHub();
		const tab1 = createMultiTabSync<{ text: string }>({
			channel: hub.connect(),
			tabId: "t1",
		});

		const received: unknown[] = [];
		tab1.onBroadcast((message) => received.push(message));
		tab1.broadcast({ text: "hello" });
		assert.deepEqual(received, []);
		tab1.dispose();
	});
});
