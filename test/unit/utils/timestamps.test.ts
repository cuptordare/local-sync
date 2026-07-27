import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { now } from "../../../src/utils/timestamps.js";

describe("now", () => {
	it("returns a number close to Date.now()", () => {
		const before = Date.now();
		const value = now();
		const after = Date.now();
		assert.ok(value >= before && value <= after);
	});
});
