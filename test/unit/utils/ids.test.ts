import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createId } from "../../../src/utils/ids.js";

describe("createId", () => {
	it("produces unique values across calls", () => {
		const a = createId();
		const b = createId();
		assert.notEqual(a, b);
	});

	it("without a prefix, returns a bare UUID", () => {
		const id = createId();
		assert.match(id, /^[0-9a-f-]{36}$/i);
	});

	it("with a prefix, prepends 'prefix_'", () => {
		const id = createId("mut");
		assert.match(id, /^mut_[0-9a-f-]{36}$/i);
	});
});
