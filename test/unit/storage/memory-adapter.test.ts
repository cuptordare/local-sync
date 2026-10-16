import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Entry } from "../../../src/crdt/lww-map.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StoredEntry } from "../../../src/storage/storage-adapter.js";

const entry = (value: unknown, stamp: number, device = "d"): Entry => ({
	value,
	deleted: false,
	stamp,
	device,
});
const one = (key: string, stored: StoredEntry) => new Map([[key, stored]]);

describe("createMemoryAdapter", () => {
	it("merge then readAll round-trips entries and synced marks", async () => {
		const storage = createMemoryAdapter();
		await storage.merge(
			"notes",
			one("a", { entry: entry("x", 5), synced: { stamp: 5, device: "d" } }),
		);
		assert.deepEqual(
			await storage.readAll("notes"),
			one("a", { entry: entry("x", 5), synced: { stamp: 5, device: "d" } }),
		);
	});

	it("keeps the newer entry: an older write can never replace a newer one", async () => {
		const storage = createMemoryAdapter();
		await storage.merge("notes", one("a", { entry: entry("new", 9) }));
		const result = await storage.merge(
			"notes",
			one("a", { entry: entry("old", 3) }),
		);
		assert.equal(result.get("a")?.entry.value, "new");
		assert.equal((await storage.readAll("notes")).get("a")?.entry.value, "new");
	});

	it("merges entries and synced marks independently, each to the later one", async () => {
		const storage = createMemoryAdapter();
		await storage.merge(
			"notes",
			one("a", { entry: entry("edit", 9), synced: { stamp: 3, device: "d" } }),
		);
		// Another tab learned the remote holds write 7 (but still had the older value).
		await storage.merge(
			"notes",
			one("a", {
				entry: entry("synced", 7),
				synced: { stamp: 7, device: "d" },
			}),
		);
		assert.deepEqual((await storage.readAll("notes")).get("a"), {
			entry: entry("edit", 9),
			synced: { stamp: 7, device: "d" },
		});
	});

	it("keeps collections apart, and remove() deletes keys outright", async () => {
		const storage = createMemoryAdapter();
		await storage.merge("a", one("k", { entry: entry(1, 1) }));
		await storage.merge("b", one("k", { entry: entry(2, 1) }));
		await storage.remove("a", ["k"]);
		assert.equal((await storage.readAll("a")).size, 0);
		assert.equal((await storage.readAll("b")).get("k")?.entry.value, 2);
	});

	it("hands out copies, so mutating a result doesn't change what's stored", async () => {
		const storage = createMemoryAdapter();
		const value = { text: "hi" };
		await storage.merge("notes", one("a", { entry: entry(value, 1) }));
		value.text = "changed by caller";
		const read = await storage.readAll("notes");
		(read.get("a")?.entry.value as { text: string }).text = "changed by reader";
		assert.deepEqual((await storage.readAll("notes")).get("a")?.entry.value, {
			text: "hi",
		});
	});
});
