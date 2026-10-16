import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalSyncApp } from "../../../src/app/create-local-sync-app.js";
import { createCollection } from "../../../src/collections/create-collection.js";
import { stampTime } from "../../../src/crdt/hlc.js";
import {
	fromLegacyRecords,
	LEGACY_DEVICE,
} from "../../../src/migration/legacy.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createBlobSyncAdapter } from "../../../src/sync/adapters/blob-sync-adapter.js";
import { createFakeBlobServer } from "../support/fake-blob-server.js";
import { createFakeNetworkStatus } from "../support/fake-network-status.js";

interface Todo {
	items: string[];
}

/** A record as the old library stored it (locally and in `{ records }` blobs). */
const legacy = (
	id: string,
	items: string[] | null,
	updatedAt: number,
	extra: Record<string, unknown> = {},
) => ({
	id,
	data: items === null ? { items: ["(deleted)"] } : { items },
	meta: {
		version: 3,
		createdAt: 1_700_000_000_000,
		updatedAt,
		deleted: items === null,
		dirty: false,
		source: "remote",
		...extra,
	},
});

/** Memory storage that also holds records "an older library version" stored. */
function storageWithLegacy(
	records: Record<string, unknown[]>,
): StorageAdapter & {
	merges: number;
} {
	const inner = createMemoryAdapter();
	const storage = {
		...inner,
		merges: 0,
		merge(collection: string, changes: Parameters<StorageAdapter["merge"]>[1]) {
			if (collection !== "__localsync") storage.merges++;
			return inner.merge(collection, changes);
		},
		readLegacy: async (collection: string) =>
			structuredClone(records[collection] ?? []),
	};
	return storage;
}

describe("legacy records -> entries", () => {
	it("stamps each record from meta.updatedAt, as the fixed legacy device", () => {
		const entries = fromLegacyRecords([
			legacy("a", ["milk"], 1_700_000_500_000),
			legacy("gone", null, 1_700_000_600_000),
		]);
		const a = entries.get("a");
		assert.equal(stampTime(a?.stamp ?? 0), 1_700_000_500_000);
		assert.equal(a?.device, LEGACY_DEVICE);
		assert.deepEqual(a?.value, { items: ["milk"] });
		assert.deepEqual(entries.get("gone"), {
			value: null,
			deleted: true,
			stamp: entries.get("gone")?.stamp,
			device: LEGACY_DEVICE,
		});
	});

	it("is deterministic, ignoring client-only bookkeeping, so every device imports identically", () => {
		const onDevice1 = fromLegacyRecords([
			legacy("a", ["milk"], 1_700_000_500_000, {
				dirty: true,
				source: "local",
			}),
		]);
		const onDevice2 = fromLegacyRecords([
			legacy("a", ["milk"], 1_700_000_500_000, {
				remoteVersion: 3,
				writer: "device_x",
			}),
		]);
		assert.deepEqual(onDevice1, onDevice2);
	});

	it("gives different records with the same updatedAt different stamps", () => {
		const one = fromLegacyRecords([legacy("a", ["x"], 1_700_000_500_000)]);
		const two = fromLegacyRecords([legacy("a", ["y"], 1_700_000_500_000)]);
		assert.notEqual(one.get("a")?.stamp, two.get("a")?.stamp);
	});

	it("keeps the newest copy of an id, and skips anything that isn't a record", () => {
		const entries = fromLegacyRecords([
			legacy("a", ["old"], 1_700_000_000_000),
			legacy("a", ["new"], 1_700_000_900_000),
			{ id: 5, meta: {} },
			"junk",
			null,
			{ id: "no-meta" },
		]);
		assert.deepEqual([...entries.keys()], ["a"]);
		assert.deepEqual(entries.get("a")?.value, { items: ["new"] });
	});

	it("treats a missing or bad updatedAt as the oldest possible time", () => {
		const entries = fromLegacyRecords([
			{ id: "a", data: { items: [] }, meta: { updatedAt: "yesterday" } },
		]);
		assert.equal(stampTime(entries.get("a")?.stamp ?? -1), 0);
	});
});

describe("importing what this device stored", () => {
	it("imports old local records on load, and writes them to storage once", async () => {
		const storage = storageWithLegacy({
			todo: [legacy("todo:shared", ["milk"], 1_700_000_500_000)],
		});
		const open = async () => {
			const todo = createCollection<Todo>({ name: "todo", storage });
			await todo.ready;
			return todo;
		};
		const first = await open();
		assert.deepEqual(first.peek("todo:shared")?.data, { items: ["milk"] });
		assert.deepEqual(first.pending(), ["todo:shared"]); // not known to be in the new remote
		const merges = storage.merges;
		const second = await open(); // a later session: nothing new to import
		assert.deepEqual(second.peek("todo:shared")?.data, { items: ["milk"] });
		assert.equal(storage.merges, merges);
	});

	it("never overrides a newer value written with the new version", async () => {
		const records = {
			todo: [legacy("todo:shared", ["old"], 1_700_000_500_000)],
		};
		const storage = storageWithLegacy(records);
		const first = createCollection<Todo>({ name: "todo", storage });
		await first.ready;
		first.upsert("todo:shared", { items: ["new"] });
		await first.whenPersisted();
		const again = createCollection<Todo>({ name: "todo", storage });
		await again.ready;
		assert.deepEqual(again.peek("todo:shared")?.data, { items: ["new"] });
	});

	it("picks up a later edit an old app version (still open in a tab) made meanwhile", async () => {
		const records = {
			todo: [legacy("todo:shared", ["v1"], 1_700_000_500_000)],
		};
		const storage = storageWithLegacy(records);
		const first = createCollection<Todo>({ name: "todo", storage });
		await first.ready;
		// The old tab edits; the next load of the new version sees it.
		records.todo = [
			legacy("todo:shared", ["v2 from old tab"], Date.now() + 1000),
		];
		const next = createCollection<Todo>({ name: "todo", storage });
		await next.ready;
		assert.deepEqual(next.peek("todo:shared")?.data, {
			items: ["v2 from old tab"],
		});
	});

	it("can be turned off", async () => {
		const storage = storageWithLegacy({
			todo: [legacy("todo:shared", ["milk"], 1_700_000_500_000)],
		});
		const todo = createCollection<Todo>({
			name: "todo",
			storage,
			importLegacy: false,
		});
		await todo.ready;
		assert.equal(todo.peek("todo:shared"), undefined);
	});
});

describe("importing the old remote row", () => {
	/** A device: old local records (optional), the new row, and the old row (read-only). */
	function device(
		newRow: ReturnType<typeof createFakeBlobServer<Todo>>,
		oldRow: unknown,
		local: Record<string, unknown[]> = {},
	) {
		let oldRowReads = 0;
		const app = createLocalSyncApp({
			storage: storageWithLegacy(local),
			network: createFakeNetworkStatus(true),
			onError: () => {},
		});
		const todo = app.keyValue<Todo>("todo", {
			remote: createBlobSyncAdapter<Todo>({
				read: () => newRow.read(),
				write: (blob, options) => newRow.write(blob, options),
				legacy: {
					read: async () => {
						oldRowReads++;
						return structuredClone(oldRow);
					},
				},
			}),
			autoSync: false,
		});
		return { app, todo, oldRowReads: () => oldRowReads };
	}

	const oldRow = {
		records: [
			legacy("todo:shared", ["milk", "eggs"], 1_700_000_500_000),
			legacy("todo:gone", null, 1_700_000_600_000),
		],
	};

	it("copies the old row into the empty new one on the first sync, and stops reading it", async () => {
		const newRow = createFakeBlobServer<Todo>({ cas: true });
		const d = device(newRow, oldRow);
		await d.app.ready();
		await d.app.sync();
		assert.deepEqual(Object.fromEntries(newRow.values()), {
			"todo:shared": { items: ["milk", "eggs"] },
		});
		assert.equal(newRow.entries["todo:gone"]?.deleted, true); // deletes carry over
		assert.deepEqual(d.todo.get("todo:shared"), { items: ["milk", "eggs"] });
		assert.deepEqual(d.todo.collection.pending(), []);
		const reads = d.oldRowReads();
		await d.app.sync();
		assert.equal(d.oldRowReads(), reads); // the new row has entries now
		await d.app.close();
	});

	it("two devices migrating at once write the same thing, and converge", async () => {
		const newRow = createFakeBlobServer<Todo>({ cas: true });
		// Device 2 also has an edit the old version never managed to push.
		const d1 = device(newRow, oldRow);
		const d2 = device(newRow, oldRow, {
			todo: [
				legacy("todo:shared", ["milk", "eggs", "bread"], 1_700_000_900_000, {
					dirty: true,
					source: "local",
				}),
			],
		});
		await Promise.all([d1.app.ready(), d2.app.ready()]);
		await Promise.all([d1.app.sync(), d2.app.sync()]);
		await d1.app.sync();
		const expected = { items: ["milk", "eggs", "bread"] };
		assert.deepEqual(d1.todo.get("todo:shared"), expected);
		assert.deepEqual(d2.todo.get("todo:shared"), expected);
		assert.deepEqual(newRow.values().get("todo:shared"), expected);
		await Promise.all([d1.app.close(), d2.app.close()]);
	});

	it("an edit made after the import beats the imported value everywhere", async () => {
		const newRow = createFakeBlobServer<Todo>({ cas: true });
		const d1 = device(newRow, oldRow);
		const d2 = device(newRow, oldRow);
		await Promise.all([d1.app.ready(), d2.app.ready()]);
		await d1.app.sync();
		d1.todo.set("todo:shared", { items: ["after migration"] });
		await d1.app.sync();
		await d2.app.sync(); // d2 imports nothing (the new row has entries) and takes d1's edit
		assert.deepEqual(d2.todo.get("todo:shared"), {
			items: ["after migration"],
		});
		await Promise.all([d1.app.close(), d2.app.close()]);
	});
});
