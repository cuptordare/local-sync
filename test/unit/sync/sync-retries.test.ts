import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBackoff, withRetry } from "../../../src/sync/sync-retries.js";

describe("computeBackoff", () => {
	it("grows exponentially with the attempt number (jitter disabled)", () => {
		const opts = { baseDelayMs: 100, factor: 2, jitter: false };
		assert.equal(computeBackoff(1, opts), 100);
		assert.equal(computeBackoff(2, opts), 200);
		assert.equal(computeBackoff(3, opts), 400);
	});

	it("caps at maxDelayMs", () => {
		const opts = {
			baseDelayMs: 1000,
			factor: 10,
			maxDelayMs: 5000,
			jitter: false,
		};
		assert.equal(computeBackoff(5, opts), 5000);
	});

	it("with jitter enabled (default), the result is within [raw/2, raw]", () => {
		const opts = { baseDelayMs: 100, factor: 2 };
		const raw = 100; // attempt 1
		for (let i = 0; i < 20; i++) {
			const delay = computeBackoff(1, opts);
			assert.ok(
				delay >= raw / 2 && delay <= raw,
				`delay ${delay} out of bounds`,
			);
		}
	});

	it("uses the documented defaults", () => {
		// base=200, factor=2 -> attempt 1 raw = 200
		const delay = computeBackoff(1, { jitter: false });
		assert.equal(delay, 200);
	});
});

describe("withRetry", () => {
	it("returns the result on first success without sleeping", async () => {
		const sleepCalls: number[] = [];
		const sleep = async (ms: number) => {
			sleepCalls.push(ms);
		};
		const result = await withRetry(async () => "ok", {}, sleep);
		assert.equal(result, "ok");
		assert.deepEqual(sleepCalls, []);
	});

	it("retries up to maxAttempts, sleeping between attempts", async () => {
		let attempts = 0;
		const sleepCalls: number[] = [];
		const sleep = async (ms: number) => {
			sleepCalls.push(ms);
		};
		const result = await withRetry(
			async () => {
				attempts += 1;
				if (attempts < 3) throw new Error("flaky");
				return "recovered";
			},
			{ maxAttempts: 5, jitter: false, baseDelayMs: 10 },
			sleep,
		);
		assert.equal(result, "recovered");
		assert.equal(attempts, 3);
		assert.equal(sleepCalls.length, 2); // slept between attempt 1->2 and 2->3
	});

	it("throws the last error after exhausting all attempts, without a trailing sleep", async () => {
		let attempts = 0;
		const sleepCalls: number[] = [];
		const sleep = async (ms: number) => {
			sleepCalls.push(ms);
		};
		await assert.rejects(
			() =>
				withRetry(
					async () => {
						attempts += 1;
						throw new Error(`fail ${attempts}`);
					},
					{ maxAttempts: 3, jitter: false, baseDelayMs: 10 },
					sleep,
				),
			/fail 3/,
		);
		assert.equal(attempts, 3);
		assert.equal(sleepCalls.length, 2); // no sleep after the final failed attempt
	});

	it("defaults to 5 max attempts", async () => {
		let attempts = 0;
		const sleep = async () => {};
		await assert.rejects(() =>
			withRetry(
				async () => {
					attempts += 1;
					throw new Error("always fails");
				},
				{ jitter: false, baseDelayMs: 1 },
				sleep,
			),
		);
		assert.equal(attempts, 5);
	});
});
