import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { debounce } from "../../../src/utils/debounce.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("debounce", () => {
	it("invokes fn once, after the wait, with the last call's args", async () => {
		const calls: number[] = [];
		const d = debounce((n: number) => calls.push(n), 20);
		d(1);
		d(2);
		d(3);
		assert.deepEqual(calls, []); // not yet
		await wait(40);
		assert.deepEqual(calls, [3]);
	});

	it("rapid re-calls reset the timer", async () => {
		const calls: number[] = [];
		const d = debounce((n: number) => calls.push(n), 30);
		d(1);
		await wait(15);
		d(2); // resets the timer before the first would have fired
		await wait(15);
		assert.deepEqual(calls, []); // 30ms hasn't elapsed since the reset
		await wait(20);
		assert.deepEqual(calls, [2]);
	});

	it("cancel() discards a pending invocation", async () => {
		const calls: number[] = [];
		const d = debounce((n: number) => calls.push(n), 15);
		d(1);
		d.cancel();
		await wait(30);
		assert.deepEqual(calls, []);
	});

	it("flush() invokes immediately and clears the timer", () => {
		const calls: number[] = [];
		const d = debounce((n: number) => calls.push(n), 1000);
		d(1);
		assert.equal(d.pending, true);
		d.flush();
		assert.deepEqual(calls, [1]);
		assert.equal(d.pending, false);
	});

	it("flush() with nothing pending is a no-op", () => {
		const calls: number[] = [];
		const d = debounce((n: number) => calls.push(n), 1000);
		d.flush();
		assert.deepEqual(calls, []);
	});

	it("pending reflects whether an invocation is scheduled", async () => {
		const d = debounce(() => {}, 15);
		assert.equal(d.pending, false);
		d();
		assert.equal(d.pending, true);
		await wait(30);
		assert.equal(d.pending, false);
	});
});
