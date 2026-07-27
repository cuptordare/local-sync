import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deepEqual } from "../../../src/utils/deep-equal.js";

describe("deepEqual", () => {
	it("primitives", () => {
		assert.equal(deepEqual(1, 1), true);
		assert.equal(deepEqual(1, 2), false);
		assert.equal(deepEqual("a", "a"), true);
		assert.equal(deepEqual(true, false), false);
		assert.equal(deepEqual(null, null), true);
		assert.equal(deepEqual(undefined, undefined), true);
		assert.equal(deepEqual(null, undefined), false);
	});

	it("NaN is equal to itself (Object.is short-circuit)", () => {
		assert.equal(deepEqual(Number.NaN, Number.NaN), true);
	});

	it("-0 and 0 are NOT equal (Object.is semantics)", () => {
		assert.equal(deepEqual(-0, 0), false);
	});

	it("nested objects", () => {
		assert.equal(deepEqual({ a: { b: 1 } }, { a: { b: 1 } }), true);
		assert.equal(deepEqual({ a: { b: 1 } }, { a: { b: 2 } }), false);
	});

	it("differing key sets are not equal", () => {
		assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
		assert.equal(deepEqual({ a: 1, b: 2 }, { a: 1 }), false);
	});

	it("arrays: order and length matter", () => {
		assert.equal(deepEqual([1, 2, 3], [1, 2, 3]), true);
		assert.equal(deepEqual([1, 2, 3], [3, 2, 1]), false);
		assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
	});

	it("an array is not equal to an object", () => {
		assert.equal(deepEqual([1, 2], { 0: 1, 1: 2 }), false);
	});

	it("Date instances compare by time value", () => {
		assert.equal(deepEqual(new Date(1000), new Date(1000)), true);
		assert.equal(deepEqual(new Date(1000), new Date(2000)), false);
	});

	it("a primitive is never equal to an object", () => {
		assert.equal(deepEqual(1, { valueOf: () => 1 }), false);
	});
});
