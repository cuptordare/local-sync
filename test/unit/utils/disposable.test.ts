import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDisposableBag } from "../../../src/utils/disposable.js";

describe("createDisposableBag", () => {
	it("dispose() runs all registered disposables in LIFO order", () => {
		const order: number[] = [];
		const bag = createDisposableBag();
		bag.add(() => order.push(1));
		bag.add(() => order.push(2));
		bag.add(() => order.push(3));
		bag.dispose();
		assert.deepEqual(order, [3, 2, 1]);
	});

	it("add() returns a function that disposes just that one entry", () => {
		const order: number[] = [];
		const bag = createDisposableBag();
		const disposeOne = bag.add(() => order.push(1));
		bag.add(() => order.push(2));
		disposeOne();
		assert.deepEqual(order, [1]);
		assert.equal(bag.size, 1);
		bag.dispose();
		assert.deepEqual(order, [1, 2]);
	});

	it("dispose() is idempotent -- a second call does nothing", () => {
		let calls = 0;
		const bag = createDisposableBag();
		bag.add(() => {
			calls += 1;
		});
		bag.dispose();
		bag.dispose();
		assert.equal(calls, 1);
	});

	it("size and disposed reflect state", () => {
		const bag = createDisposableBag();
		assert.equal(bag.size, 0);
		assert.equal(bag.disposed, false);
		bag.add(() => {});
		assert.equal(bag.size, 1);
		bag.dispose();
		assert.equal(bag.disposed, true);
	});

	it("add() after dispose() invokes the disposable immediately and is a no-op bag entry", () => {
		const bag = createDisposableBag();
		bag.dispose();
		let called = false;
		bag.add(() => {
			called = true;
		});
		assert.equal(called, true);
		assert.equal(bag.size, 0);
	});
});
