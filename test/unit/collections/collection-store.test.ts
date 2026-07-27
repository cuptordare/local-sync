import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollectionStore } from "../../../src/collections/collection-store.js";
import { createEnvelope } from "../../../src/records/record-envelope.js";

describe("createCollectionStore", () => {
	it("get/getAll/has/size reflect stored records", () => {
		const store = createCollectionStore<{ n: number }>();
		const a = createEnvelope({ n: 1 }, { id: "a" });
		store.set(a);
		assert.equal(store.get("a"), a);
		assert.equal(store.has("a"), true);
		assert.equal(store.has("missing"), false);
		assert.equal(store.size, 1);
		assert.deepEqual(store.getAll(), [a]);
	});

	it("set() upserts and notifies a 'set' change", () => {
		const store = createCollectionStore<{ n: number }>();
		const changes: unknown[] = [];
		store.subscribe((c) => changes.push(c));
		const a = createEnvelope({ n: 1 }, { id: "a" });
		store.set(a);
		assert.deepEqual(changes, [[{ kind: "set", id: "a", record: a }]]);
	});

	it("setMany() batches multiple records into one notification", () => {
		const store = createCollectionStore<{ n: number }>();
		const notifications: unknown[][] = [];
		store.subscribe((c) => notifications.push([...c]));
		const a = createEnvelope({ n: 1 }, { id: "a" });
		const b = createEnvelope({ n: 2 }, { id: "b" });
		store.setMany([a, b]);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.length, 2);
	});

	it("remove() returns whether the record existed and notifies 'removed'", () => {
		const store = createCollectionStore<{ n: number }>();
		const changes: unknown[] = [];
		store.set(createEnvelope({ n: 1 }, { id: "a" }));
		store.subscribe((c) => changes.push(c));

		assert.equal(store.remove("missing"), false);
		assert.deepEqual(changes, []);

		assert.equal(store.remove("a"), true);
		assert.deepEqual(changes, [[{ kind: "removed", id: "a" }]]);
	});

	it("notify is a no-op for an empty changes array (setMany([]))", () => {
		const store = createCollectionStore<{ n: number }>();
		let called = false;
		store.subscribe(() => {
			called = true;
		});
		store.setMany([]);
		assert.equal(called, false);
	});

	it("multiple listeners all receive the same batch", () => {
		const store = createCollectionStore<{ n: number }>();
		const seenA: unknown[] = [];
		const seenB: unknown[] = [];
		store.subscribe((c) => seenA.push(c));
		store.subscribe((c) => seenB.push(c));
		store.set(createEnvelope({ n: 1 }, { id: "a" }));
		assert.deepEqual(seenA, seenB);
	});
});
