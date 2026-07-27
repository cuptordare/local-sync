import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReactiveStore } from "../../../src/reactivity/reactive-store.js";

describe("createReactiveStore", () => {
	it("returns the initial value", () => {
		const store = createReactiveStore("idle");
		assert.equal(store.get(), "idle");
	});

	it("notifies subscribers when the value changes", () => {
		const store = createReactiveStore("idle");
		const seen: string[] = [];
		store.subscribe((v) => seen.push(v));
		store.set("loading");
		assert.deepEqual(seen, ["loading"]);
	});

	it("does not notify when set to an Object.is-equal value", () => {
		const store = createReactiveStore("idle");
		const seen: string[] = [];
		store.subscribe((v) => seen.push(v));
		store.set("idle");
		assert.deepEqual(seen, []);
	});

	it("subscribing does not immediately call the listener", () => {
		const store = createReactiveStore("idle");
		const seen: string[] = [];
		store.subscribe((v) => seen.push(v));
		assert.deepEqual(seen, []);
	});

	it("supports a custom equals function", () => {
		const store = createReactiveStore(
			{ n: 1 },
			{ equals: (a, b) => a.n === b.n },
		);
		const seen: number[] = [];
		store.subscribe((v) => seen.push(v.n));
		store.set({ n: 1 }); // different reference, equal per custom equals
		assert.deepEqual(seen, []);
		store.set({ n: 2 });
		assert.deepEqual(seen, [2]);
	});

	it("update() derives the next value from the current one", () => {
		const store = createReactiveStore(1);
		store.update((n) => n + 1);
		assert.equal(store.get(), 2);
	});

	it("unsubscribe stops further notifications", () => {
		const store = createReactiveStore(0);
		const seen: number[] = [];
		const off = store.subscribe((v) => seen.push(v));
		store.set(1);
		off();
		store.set(2);
		assert.deepEqual(seen, [1]);
	});

	it("listenerCount reflects subscriptions", () => {
		const store = createReactiveStore(0);
		assert.equal(store.listenerCount, 0);
		const off1 = store.subscribe(() => {});
		const off2 = store.subscribe(() => {});
		assert.equal(store.listenerCount, 2);
		off1();
		assert.equal(store.listenerCount, 1);
		off2();
		assert.equal(store.listenerCount, 0);
	});

	it("is resilient to a listener unsubscribing itself during notification", () => {
		const store = createReactiveStore(0);
		const seen: number[] = [];
		let off2: (() => void) | undefined;
		const off1 = store.subscribe(() => {
			off2?.();
		});
		off2 = store.subscribe((v) => seen.push(v));
		store.set(1);
		// off1 ran first (Set insertion order), unsubscribed off2 mid-notification;
		// the snapshot taken before notifying means off2's listener still fires once.
		assert.deepEqual(seen, [1]);
		off1();
	});
});
