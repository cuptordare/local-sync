import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollection } from "../../../src/collections/create-collection.js";
import { loadDeviceId, loadWriterId } from "../../../src/storage/device-id.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";

describe("device id", () => {
	it("is kept in storage, so every tab and session on one storage shares it", async () => {
		const storage = createMemoryAdapter();
		const first = await loadDeviceId(storage);
		assert.match(first, /^[a-z0-9]{10}$/);
		// A second "tab" on the same storage (the cache is per adapter object).
		const sameStorage = { ...storage };
		assert.equal(await loadDeviceId(sameStorage), first);
		assert.notEqual(await loadDeviceId(createMemoryAdapter()), first);
	});

	it("tabs creating it at the same moment store one id, which later sessions use", async () => {
		// (A tab that created its id first may keep using its own for that session; ids only
		// label writes, and each tab's writer id is unique anyway.)
		const storage = createMemoryAdapter();
		const ids = await Promise.all([
			loadDeviceId({ ...storage }),
			loadDeviceId({ ...storage }),
		]);
		const later = await loadDeviceId({ ...storage });
		assert.ok(ids.includes(later));
		assert.equal(await loadDeviceId({ ...storage }), later);
	});

	it("still loads when it can't be saved (it only labels writes)", async () => {
		const storage = {
			...createMemoryAdapter(),
			merge: async () => {
				throw new Error("quota exceeded");
			},
		};
		assert.match(await loadDeviceId(storage), /^[a-z0-9]{10}$/);
	});

	it("each tab writes as the device id plus its own tab id", async () => {
		const storage = createMemoryAdapter();
		const device = await loadDeviceId(storage);
		const a = await loadWriterId({ ...storage });
		const b = await loadWriterId({ ...storage });
		assert.match(a, new RegExp(`^${device}\\.[a-z0-9]{4}$`));
		assert.notEqual(a, b);
	});

	it("stamps local writes with this tab's writer id", async () => {
		const notes = createCollection<{ text: string }>({
			name: "notes",
			storage: createMemoryAdapter(),
			writerId: async () => "dev1.tab1",
		});
		await notes.ready;
		notes.upsert("a", { text: "hi" });
		assert.equal(notes.peek("a")?.meta.device, "dev1.tab1");
	});
});
