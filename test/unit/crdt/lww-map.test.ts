import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { createHybridClock } from "../../../src/crdt/hlc.js";
import type { Entry } from "../../../src/crdt/lww-map.js";
import {
	compareEntries,
	keysNewerIn,
	mergeEntries,
	newerEntry,
} from "../../../src/crdt/lww-map.js";

/** Plain-object form, so maps compare by content (deepStrictEqual ignores key order). */
const plain = (map: ReadonlyMap<string, Entry>) =>
	Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));

// Few stamps, devices and keys, so ties and overlaps are common.
const valueArb = fc.oneof(
	fc.constantFrom(1, "x", true, null),
	// The same object with its keys in either order: equal values that serialize differently.
	fc.constantFrom({ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 2 }),
	fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 2 }),
);
const entryArb: fc.Arbitrary<Entry> = fc
	.record({
		value: valueArb,
		deleted: fc.boolean(),
		stamp: fc.integer({ min: 0, max: 3 }),
		device: fc.constantFrom("a", "b", "c"),
	})
	// (Spread: fast-check may build null-prototype objects, which deepStrictEqual tells apart.)
	.map((e) => ({ ...e, value: e.deleted ? null : e.value }));
const mapArb = fc
	.array(fc.tuple(fc.constantFrom("k1", "k2", "k3", "k4"), entryArb), {
		maxLength: 6,
	})
	.map((pairs) => new Map(pairs));

describe("LWW map merge", () => {
	it("is commutative", () => {
		fc.assert(
			fc.property(mapArb, mapArb, (a, b) => {
				assert.deepStrictEqual(
					plain(mergeEntries(a, b)),
					plain(mergeEntries(b, a)),
				);
			}),
			{ numRuns: 2000 },
		);
	});

	it("is associative", () => {
		fc.assert(
			fc.property(mapArb, mapArb, mapArb, (a, b, c) => {
				assert.deepStrictEqual(
					plain(mergeEntries(mergeEntries(a, b), c)),
					plain(mergeEntries(a, mergeEntries(b, c))),
				);
			}),
			{ numRuns: 2000 },
		);
	});

	it("is idempotent", () => {
		fc.assert(
			fc.property(mapArb, mapArb, (a, b) => {
				assert.deepStrictEqual(plain(mergeEntries(a, a)), plain(a));
				const ab = mergeEntries(a, b);
				assert.deepStrictEqual(plain(mergeEntries(ab, b)), plain(ab));
				assert.deepStrictEqual(plain(mergeEntries(ab, a)), plain(ab));
			}),
			{ numRuns: 2000 },
		);
	});

	it("orders entries totally: only identical writes compare equal", () => {
		fc.assert(
			fc.property(entryArb, entryArb, (a, b) => {
				const ab = compareEntries(a, b);
				assert.equal(Math.sign(ab) + Math.sign(compareEntries(b, a)), 0);
				if (ab === 0) assert.deepStrictEqual(a, b);
			}),
			{ numRuns: 2000 },
		);
	});

	it("keysNewerIn finds exactly the keys a merge would take from the first map", () => {
		fc.assert(
			fc.property(mapArb, mapArb, (a, b) => {
				const merged = mergeEntries(b, a);
				for (const key of keysNewerIn(a, b)) {
					assert.equal(merged.get(key), a.get(key));
				}
				for (const [key, entry] of merged) {
					if (!keysNewerIn(a, b).includes(key)) assert.equal(entry, b.get(key));
				}
			}),
			{ numRuns: 1000 },
		);
	});

	it("newerEntry keeps the first entry of a tie", () => {
		const a: Entry = { value: 1, deleted: false, stamp: 5, device: "d" };
		assert.equal(newerEntry(a, { ...a }), a);
		assert.equal(newerEntry(undefined, a), a);
		assert.equal(newerEntry(a, undefined), a);
	});
});

/**
 * Replicas with skewed wall clocks write keys and exchange their maps at random. Whatever the
 * order, a write made after seeing another write to the same key (directly or through other
 * replicas) must beat it -- so the key always ends with a write nobody overwrote knowingly.
 */
describe("causality", () => {
	interface Write {
		id: number;
		key: string;
		knows: ReadonlySet<number>;
	}

	const opArb = fc.oneof(
		fc.record({
			kind: fc.constant("write" as const),
			replica: fc.integer({ min: 0, max: 2 }),
			key: fc.constantFrom("x", "y"),
			deleted: fc.boolean(),
			tick: fc.integer({ min: -5, max: 5 }), // wall clocks drift, even backwards
		}),
		fc.record({
			kind: fc.constant("sync" as const),
			from: fc.integer({ min: 0, max: 2 }),
			to: fc.integer({ min: 0, max: 2 }),
		}),
	);

	it("a causally later write always wins", () => {
		fc.assert(
			fc.property(
				fc.array(opArb, { maxLength: 40 }),
				fc.array(fc.integer({ min: -50, max: 50 }), {
					minLength: 3,
					maxLength: 3,
				}),
				(ops, skews) => {
					const writes: Write[] = [];
					const replicas = skews.map((skew, i) => {
						let wall = 1000 + skew;
						return {
							device: `r${i}`,
							map: new Map<string, Entry<number>>(),
							seen: new Set<number>(),
							clock: createHybridClock(() => wall),
							tick: (n: number) => {
								wall += n;
							},
						};
					});
					for (const op of ops) {
						if (op.kind === "write") {
							const r = replicas[op.replica] as (typeof replicas)[number];
							r.tick(op.tick);
							const id = writes.length;
							writes.push({ id, key: op.key, knows: new Set(r.seen) });
							r.seen.add(id);
							r.map.set(op.key, {
								value: op.deleted ? null : id,
								deleted: op.deleted,
								stamp: r.clock.now(),
								device: r.device,
							});
							// Deletes carry no value: remember which write each entry is.
							writeOf.set(r.map.get(op.key) as Entry, id);
						} else {
							const from = replicas[op.from] as (typeof replicas)[number];
							const to = replicas[op.to] as (typeof replicas)[number];
							to.map = mergeEntries(to.map, from.map);
							for (const entry of from.map.values())
								to.clock.receive(entry.stamp);
							for (const id of from.seen) to.seen.add(id);
						}
					}
					const final = replicas.reduce(
						(acc, r) => mergeEntries(acc, r.map),
						new Map<string, Entry<number>>(),
					);
					for (const [key, entry] of final) {
						const winner = writeOf.get(entry) as number;
						const overwrittenKnowingly = writes.some(
							(w) => w.key === key && w.knows.has(winner),
						);
						assert.ok(
							!overwrittenKnowingly,
							`write ${winner} won "${key}", but a later write knew of it`,
						);
					}
				},
			),
			{ numRuns: 1000 },
		);
	});

	const writeOf = new Map<Entry, number>();
});
