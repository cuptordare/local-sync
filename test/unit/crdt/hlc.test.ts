import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import {
	createHybridClock,
	stampAt,
	stampTime,
} from "../../../src/crdt/hlc.js";

describe("hybrid logical clock", () => {
	const opArb = fc.oneof(
		fc.record({
			kind: fc.constant("now" as const),
			wall: fc.integer({ min: 0, max: 2_000_000_000_000 }), // jumps around, even backwards
		}),
		fc.record({
			kind: fc.constant("receive" as const),
			stamp: fc.integer({ min: 0, max: 2_000_000_000_000_000 }),
		}),
	);

	it("is monotonic and advances past every stamp received", () => {
		fc.assert(
			fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
				let wall = 0;
				const clock = createHybridClock(() => wall);
				let floor = -1; // every later stamp must be greater than this
				for (const op of ops) {
					if (op.kind === "receive") {
						clock.receive(op.stamp);
						floor = Math.max(floor, op.stamp);
					} else {
						wall = op.wall;
						const stamp = clock.now();
						assert.ok(stamp > floor, `${stamp} is not after ${floor}`);
						assert.ok(Number.isSafeInteger(stamp));
						floor = stamp;
					}
				}
			}),
			{ numRuns: 2000 },
		);
	});

	it("follows the wall clock when it moves forward", () => {
		let wall = 1_760_000_000_000;
		const clock = createHybridClock(() => wall);
		const a = clock.now();
		assert.equal(a, stampAt(wall));
		assert.equal(clock.now(), a + 1); // same millisecond: the counter moves
		wall += 5;
		assert.equal(clock.now(), stampAt(wall));
		assert.equal(stampTime(clock.now()), wall);
	});

	it("ignores malformed stamps", () => {
		const clock = createHybridClock(() => 1);
		clock.receive(Number.NaN);
		clock.receive(-5);
		clock.receive(1.5);
		clock.receive(Number.MAX_VALUE);
		assert.equal(clock.now(), stampAt(1));
	});
});
