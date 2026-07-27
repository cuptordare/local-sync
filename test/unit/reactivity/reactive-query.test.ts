import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReactiveQuery } from "../../../src/reactivity/reactive-query.js";
import { createReactiveStore } from "../../../src/reactivity/reactive-store.js";

describe("createReactiveQuery", () => {
	it("getCurrentResult() computes on demand before any subscription", () => {
		let calls = 0;
		const query = createReactiveQuery({
			compute: () => {
				calls += 1;
				return calls;
			},
		});
		assert.equal(query.getCurrentResult(), 1);
		assert.equal(query.getCurrentResult(), 2); // unobserved -> recomputes every read
	});

	it("caches the result reference while observed and only notifies on real change", () => {
		const source = createReactiveStore(1);
		const query = createReactiveQuery({
			compute: () => ({ n: source.get() }),
			subscribeToSources: (onChange) => source.subscribe(() => onChange()),
		});

		const seen: Array<{ n: number }> = [];
		query.subscribe((v) => seen.push(v));

		const first = query.getCurrentResult();
		const again = query.getCurrentResult();
		assert.equal(first, again); // stable reference while observed

		source.set(1); // store no-ops on Object.is-equal value; no notification
		assert.equal(seen.length, 0);

		source.set(2);
		assert.equal(seen.length, 1);
		assert.deepEqual(seen[0], { n: 2 });
	});

	it("subscribeToSources is invoked only on the 0->1 listener transition", () => {
		let subscribeCalls = 0;
		let unsubscribeCalls = 0;
		const query = createReactiveQuery({
			compute: () => 1,
			subscribeToSources: () => {
				subscribeCalls += 1;
				return () => {
					unsubscribeCalls += 1;
				};
			},
		});

		const offA = query.subscribe(() => {});
		const offB = query.subscribe(() => {});
		assert.equal(subscribeCalls, 1);

		offA();
		assert.equal(unsubscribeCalls, 0); // still one listener (offB)

		offB();
		assert.equal(unsubscribeCalls, 1); // 1->0, source torn down
	});

	it("re-subscribing after 1->0 resubscribes to sources", () => {
		let subscribeCalls = 0;
		const query = createReactiveQuery({
			compute: () => 1,
			subscribeToSources: () => {
				subscribeCalls += 1;
				return () => {};
			},
		});
		const off1 = query.subscribe(() => {});
		off1();
		query.subscribe(() => {});
		assert.equal(subscribeCalls, 2);
	});

	it("invalidate() forces a recompute and notifies only if the value changed", () => {
		let value = 1;
		const query = createReactiveQuery({ compute: () => value });
		const seen: number[] = [];
		query.subscribe((v) => seen.push(v));

		query.invalidate(); // value unchanged
		assert.deepEqual(seen, []);

		value = 2;
		query.invalidate();
		assert.deepEqual(seen, [2]);
	});

	it("a query with no subscribeToSources only updates via invalidate()", () => {
		let value = 1;
		const query = createReactiveQuery({ compute: () => value });
		assert.equal(query.getCurrentResult(), 1);
		value = 2;
		// Unobserved reads always recompute (per getCurrentResult's documented behavior).
		assert.equal(query.getCurrentResult(), 2);
	});

	it("dispose() clears listeners and tears down the source subscription", () => {
		let unsubscribeCalls = 0;
		const query = createReactiveQuery({
			compute: () => 1,
			subscribeToSources: () => () => {
				unsubscribeCalls += 1;
			},
		});
		const seen: number[] = [];
		query.subscribe((v) => seen.push(v));
		query.dispose();
		assert.equal(unsubscribeCalls, 1);
		query.invalidate();
		assert.deepEqual(seen, []); // no listeners left
	});

	it("uses deepEqual by default so structurally-equal results don't notify", () => {
		let n = 0;
		const query = createReactiveQuery({ compute: () => ({ list: [n] }) });
		const seen: unknown[] = [];
		query.subscribe((v) => seen.push(v));
		query.invalidate(); // still { list: [0] } -- deepEqual, no notify
		assert.deepEqual(seen, []);
		n = 1;
		query.invalidate();
		assert.equal(seen.length, 1);
	});

	it("supports a custom equals function", () => {
		let n = 1;
		const query = createReactiveQuery({
			compute: () => n,
			equals: (a, b) => Math.floor(a / 10) === Math.floor(b / 10),
		});
		const seen: number[] = [];
		query.subscribe((v) => seen.push(v));
		n = 5; // still in the same "bucket" as 1
		query.invalidate();
		assert.deepEqual(seen, []);
		n = 15;
		query.invalidate();
		assert.deepEqual(seen, [15]);
	});
});
