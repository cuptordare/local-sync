import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	fromGuard,
	invalid,
	passthrough,
	ValidationError,
	valid,
	validateOrThrow,
} from "../../../src/records/record-validation.js";

describe("valid / invalid", () => {
	it("valid() produces an ok result", () => {
		assert.deepEqual(valid(42), { ok: true, value: 42 });
	});

	it("invalid() accepts a plain string message", () => {
		const result = invalid("bad");
		assert.equal(result.ok, false);
		assert.deepEqual(result.issues, [{ message: "bad" }]);
	});

	it("invalid() accepts an explicit issue array", () => {
		const issues = [{ path: "n", message: "must be positive" }];
		const result = invalid(issues);
		assert.equal(result.ok, false);
		assert.equal(result.issues, issues);
	});
});

describe("passthrough", () => {
	it("always succeeds, returning the input as-is", () => {
		const validator = passthrough<{ n: number }>();
		const result = validator({ n: 1 });
		assert.deepEqual(result, { ok: true, value: { n: 1 } });
	});
});

describe("fromGuard", () => {
	const isNumber = (d: unknown): d is number => typeof d === "number";

	it("succeeds when the guard passes", () => {
		const validator = fromGuard(isNumber);
		assert.deepEqual(validator(5), { ok: true, value: 5 });
	});

	it("fails with the given message when the guard fails", () => {
		const validator = fromGuard(isNumber, "not a number");
		const result = validator("nope");
		assert.equal(result.ok, false);
		assert.deepEqual(result.issues, [{ message: "not a number" }]);
	});

	it("defaults to a generic message", () => {
		const validator = fromGuard(isNumber);
		const result = validator("nope");
		assert.equal(result.ok, false);
		assert.deepEqual(result.issues, [{ message: "Validation failed" }]);
	});
});

describe("validateOrThrow", () => {
	it("returns the value on success", () => {
		assert.equal(validateOrThrow(passthrough<number>(), 5), 5);
	});

	it("throws a ValidationError with .issues on failure", () => {
		const validator = fromGuard(
			(d: unknown): d is number => typeof d === "number",
			"must be a number",
		);
		assert.throws(
			() => validateOrThrow(validator, "nope"),
			(err: unknown) => {
				assert.ok(err instanceof ValidationError);
				assert.deepEqual(err.issues, [{ message: "must be a number" }]);
				assert.equal(err.message, "must be a number");
				return true;
			},
		);
	});

	it("ValidationError joins multiple issues, including paths", () => {
		const err = new ValidationError([
			{ path: "a", message: "bad a" },
			{ message: "bad b" },
		]);
		assert.equal(err.message, "a: bad a; bad b");
	});
});
