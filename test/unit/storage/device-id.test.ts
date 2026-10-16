import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollection } from "../../../src/collections/create-collection.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";

const collectionOn = (storage: StorageAdapter, name = "items") =>
	createCollection<{ n: number }>({
		name,
		storage: createStorageEngine(storage),
	});

describe("device id", () => {
	it("is shared by every collection and tab on one storage, and kept across sessions", async () => {
		const storage = createMemoryAdapter();
		const a = collectionOn(storage);
		const b = collectionOn(storage, "other"); // another collection, or another tab
		await Promise.all([a.ready, b.ready]);
		assert.ok(a.deviceId);
		assert.equal(b.deviceId, a.deviceId);

		const later = collectionOn(storage); // e.g. after a reload
		await later.ready;
		assert.equal(later.deviceId, a.deviceId);

		const elsewhere = collectionOn(createMemoryAdapter()); // another device
		await elsewhere.ready;
		assert.notEqual(elsewhere.deviceId, a.deviceId);
	});

	it("stamps local edits with it", async () => {
		const items = collectionOn(createMemoryAdapter());
		await items.ready;
		const id = items.insert({ n: 1 });
		assert.equal(items.peek(id)?.meta.writer, items.deviceId);
	});
});
