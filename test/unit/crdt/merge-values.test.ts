import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { mergeValues } from "../../../src/crdt/merge-values.js";

const mineLater = { key: "k", mineIsLater: true };
const theirsLater = { key: "k", mineIsLater: false };

describe("mergeValues (default 3-way merge)", () => {
	it("keeps both sides' changes to different fields", () => {
		const base = { completed: false, assignedTo: null, agendaIndex: 0 };
		assert.deepEqual(
			mergeValues(
				base,
				{ ...base, completed: true },
				{ ...base, assignedTo: "SW" },
				theirsLater,
			),
			{ completed: true, assignedTo: "SW", agendaIndex: 0 },
		);
	});

	it("the same field changed both ways: the later edit wins", () => {
		const base = { title: "a" };
		assert.deepEqual(
			mergeValues(base, { title: "mine" }, { title: "theirs" }, mineLater),
			{ title: "mine" },
		);
		assert.deepEqual(
			mergeValues(base, { title: "mine" }, { title: "theirs" }, theirsLater),
			{ title: "theirs" },
		);
	});

	it("merges lists of strings as sets: both additions kept, both removals applied", () => {
		const base = { items: ["milk", "eggs", "bread"] };
		const mine = { items: ["milk", "bread", "apples"] }; // removed eggs, added apples
		const theirs = { items: ["milk", "eggs", "bread", "jam"] }; // added jam
		assert.deepEqual(mergeValues(base, mine, theirs, theirsLater), {
			items: ["milk", "bread", "apples", "jam"],
		});
	});

	it("merges lists of objects with ids item by item (the schedule's shape)", () => {
		const base = {
			monday: [{ id: "a", title: "Swim", startTime: "17:00" }],
			tuesday: [],
		};
		const mine = {
			monday: [{ id: "a", title: "Swim", startTime: "18:00" }], // moved it
			tuesday: [{ id: "b", title: "Piano", startTime: "16:00" }], // added one
		};
		const theirs = {
			monday: [
				{ id: "a", title: "Swim lesson", startTime: "17:00" }, // renamed it
				{ id: "c", title: "Dentist", startTime: "09:00" }, // added one
			],
			tuesday: [],
		};
		assert.deepEqual(mergeValues(base, mine, theirs, mineLater), {
			monday: [
				{ id: "a", title: "Swim lesson", startTime: "18:00" },
				{ id: "c", title: "Dentist", startTime: "09:00" },
			],
			tuesday: [{ id: "b", title: "Piano", startTime: "16:00" }],
		});
	});

	it("an item removed on one side and edited on the other is kept, edited", () => {
		const base = [{ id: 1, done: false }];
		assert.deepEqual(
			mergeValues(base, [], [{ id: 1, done: true }], mineLater),
			[{ id: 1, done: true }],
		);
		assert.deepEqual(mergeValues(base, [], base, mineLater), []); // removed, untouched: gone
	});

	it("values both sides created at once are merged as if from nothing", () => {
		assert.deepEqual(
			mergeValues(
				undefined,
				{ a: 1, list: ["x"] },
				{ b: 2, list: ["y"] },
				mineLater,
			),
			{ a: 1, list: ["x", "y"], b: 2 },
		);
	});

	it("never changes its inputs", () => {
		const base = { items: ["a"] };
		const mine = { items: ["a", "b"] };
		const theirs = { items: [] as string[], x: 1 };
		const copies = structuredClone({ base, mine, theirs });
		mergeValues(base, mine, theirs, mineLater);
		assert.deepEqual({ base, mine, theirs }, copies);
	});

	// Properties, over small JSON values built from a few shared pieces (so edits overlap).
	const leaf = fc.oneof(fc.constantFrom("a", "b", 1, 2, true, null));
	const json: fc.Arbitrary<unknown> = fc
		.letrec((tie) => ({
			value: fc.oneof(
				{ depthSize: "small" },
				leaf,
				fc.uniqueArray(fc.constantFrom("x", "y", "z"), { maxLength: 3 }),
				fc.dictionary(fc.constantFrom("p", "q", "r"), tie("value"), {
					maxKeys: 3,
				}),
			),
		}))
		.value.map((v) => JSON.parse(JSON.stringify(v)) as unknown); // plain objects only

	it("only one side changed: that side's value, exactly", () => {
		fc.assert(
			fc.property(json, json, fc.boolean(), (base, edit, mineIsLater) => {
				const ctx = { key: "k", mineIsLater };
				assert.deepEqual(mergeValues(base, edit, base, ctx), edit);
				assert.deepEqual(mergeValues(base, base, edit, ctx), edit);
				assert.deepEqual(mergeValues(base, edit, edit, ctx), edit);
			}),
			{ numRuns: 2000 },
		);
	});

	it("swapping the sides gives the same result up to list order", () => {
		const sortLists = (v: unknown): unknown =>
			Array.isArray(v)
				? v
						.map(sortLists)
						.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
				: typeof v === "object" && v !== null
					? Object.fromEntries(
							Object.entries(v).map(([k, x]) => [k, sortLists(x)]),
						)
					: v;
		fc.assert(
			fc.property(json, json, json, fc.boolean(), (base, a, b, aIsLater) => {
				assert.deepEqual(
					sortLists(
						mergeValues(base, a, b, { key: "k", mineIsLater: aIsLater }),
					),
					sortLists(
						mergeValues(base, b, a, { key: "k", mineIsLater: !aIsLater }),
					),
				);
			}),
			{ numRuns: 2000 },
		);
	});
});
