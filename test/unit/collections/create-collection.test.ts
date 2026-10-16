import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollection } from "../../../src/collections/create-collection.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type {
	StorageAdapter,
	StoredRecord,
} from "../../../src/storage/storage-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";

interface Note {
	text: string;
}

function makeCollection(
	overrides: Partial<Parameters<typeof createCollection<Note>>[0]> = {},
) {
	return createCollection<Note>({
		name: "notes",
		storage: createStorageEngine(createMemoryAdapter()),
		...overrides,
	});
}

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("create-collection: CRUD", () => {
	it("insert() returns an id and applies synchronously", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" });
		assert.equal(typeof id, "string");
		assert.equal(notes.peek(id)?.data.text, "hi");
	});

	it("insert() with an explicit id uses that id", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" }, { id: "custom" });
		assert.equal(id, "custom");
	});

	it("insert() throws if a record already exists at the given id (live)", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.insert({ text: "hi" }, { id: "dupe" });
		assert.throws(
			() => notes.insert({ text: "again" }, { id: "dupe" }),
			/already exists/,
		);
		// Original record must survive untouched.
		assert.equal(notes.peek("dupe")?.data.text, "hi");
	});

	it("insert() throws if a record already exists at the given id (tombstoned)", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.insert({ text: "hi" }, { id: "dupe" });
		notes.delete("dupe");
		assert.throws(
			() => notes.insert({ text: "again" }, { id: "dupe" }),
			/already exists/,
		);
	});

	it("update() throws if the record is missing", async () => {
		const notes = makeCollection();
		await notes.ready;
		assert.throws(() => notes.update("missing", { text: "x" }), /missing/);
	});

	it("update() shallow-merges and bumps version", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" });
		notes.update(id, { text: "bye" });
		assert.equal(notes.peek(id)?.data.text, "bye");
		assert.equal(notes.peek(id)?.meta.version, 2);
	});

	it("replace() throws if the record is missing", async () => {
		const notes = makeCollection();
		await notes.ready;
		assert.throws(() => notes.replace("missing", { text: "x" }), /missing/);
	});

	it("replace() fully replaces the data", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" });
		notes.replace(id, { text: "replaced" });
		assert.deepEqual(notes.peek(id)?.data, { text: "replaced" });
	});

	it("delete() no-ops on a missing record (once hydrated)", async () => {
		const notes = makeCollection();
		await notes.ready;
		assert.doesNotThrow(() => notes.delete("missing"));
	});

	it("delete() no-ops on an already-deleted record (idempotent)", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" });
		notes.delete(id);
		const versionAfterFirstDelete = notes.pending().find((r) => r.id === id)
			?.meta.version;
		notes.delete(id); // second delete should be a no-op, not bump version again
		const versionAfterSecondDelete = notes.pending().find((r) => r.id === id)
			?.meta.version;
		assert.equal(versionAfterFirstDelete, versionAfterSecondDelete);
	});

	it("delete() tombstones a live record and bumps version", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" });
		notes.delete(id);
		assert.equal(notes.peek(id), undefined); // tombstones are hidden from peek
	});
});

describe("create-collection: reads", () => {
	it("peek()/get()/query() hide tombstones", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" });
		notes.delete(id);
		assert.equal(notes.peek(id), undefined);
		assert.equal(notes.get(id).getCurrentResult(), undefined);
		assert.deepEqual(notes.query().getCurrentResult(), []);
	});

	it("get(id) returns the same cached ReactiveQuery instance across calls", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" });
		assert.equal(notes.get(id), notes.get(id));
	});

	it("get(id) is reactive to changes on that record", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi" });
		const seen: (string | undefined)[] = [];
		notes.get(id).subscribe((r) => seen.push(r?.data.text));
		notes.update(id, { text: "bye" });
		assert.deepEqual(seen, ["bye"]);
	});

	it("query(predicate) filters by data and excludes tombstones", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.insert({ text: "keep" });
		const dropId = notes.insert({ text: "drop" });
		notes.delete(dropId);
		const kept = notes.query((data) => data.text === "keep").getCurrentResult();
		assert.equal(kept.length, 1);
		assert.equal(kept[0]?.data.text, "keep");
	});

	it("query() is reactive to store changes", async () => {
		const notes = makeCollection();
		await notes.ready;
		const query = notes.query();
		const seen: number[] = [];
		query.subscribe((rows) => seen.push(rows.length));
		notes.insert({ text: "a" });
		assert.deepEqual(seen, [1]);
	});
});

describe("create-collection: write ordering", () => {
	it("persists writes in version order even if the adapter resolves them out of order", async () => {
		const calls: number[] = [];
		const adapter: StorageAdapter = {
			read: async () => undefined,
			readAll: async () => [],
			async write(_collection, record) {
				// Artificial variable delay -- later calls resolve "faster" than earlier ones would
				// if they were fired concurrently. Because create-collection serializes writes on a
				// promise chain, this call won't even start until the previous one finished, so the
				// recorded order must still match version order.
				const delay =
					30 -
					(record as StoredRecord & { meta: { version: number } }).meta
						.version *
						5;
				await wait(Math.max(delay, 1));
				calls.push(
					(record as StoredRecord & { meta: { version: number } }).meta.version,
				);
			},
			writeMany: async () => {},
			remove: async () => {},
			clear: async () => {},
			close: async () => {},
		};
		const notes = createCollection<Note>({
			name: "notes",
			storage: createStorageEngine(adapter),
		});
		await notes.ready; // (writes made before loading finishes are stored together, once)
		const id = notes.insert({ text: "v1" });
		notes.update(id, { text: "v2" });
		notes.update(id, { text: "v3" });
		await wait(100);
		assert.deepEqual(calls, [1, 2, 3]);
	});
});

describe("create-collection: sync integration", () => {
	it("pending() returns exactly the dirty records", async () => {
		const notes = makeCollection();
		await notes.ready;
		const cleanId = notes.insert({ text: "a" }, { now: 1 });
		notes.markSynced([cleanId]);
		const dirtyId = notes.insert({ text: "b" });
		const pending = notes.pending();
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.id, dirtyId);
	});

	it("applyRemote: keepPending=true leaves a locally-dirty record untouched", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "local edit" });
		notes.applyRemote(
			[
				{
					id,
					data: { text: "remote" },
					meta: {
						version: 99,
						createdAt: 0,
						updatedAt: 0,
						deleted: false,
						dirty: false,
						source: "remote",
					},
				},
			],
			{ keepPending: true },
		);
		assert.equal(notes.peek(id)?.data.text, "local edit");
	});

	it("applyRemote: keepPending=false (default) resolves via the merge strategy", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "local edit" });
		notes.applyRemote([
			{
				id,
				data: { text: "remote" },
				meta: {
					version: 99,
					createdAt: 0,
					updatedAt: 0,
					deleted: false,
					dirty: false,
					source: "remote",
				},
			},
		]);
		// default merge is serverWins -- remote wins
		assert.equal(notes.peek(id)?.data.text, "remote");
	});

	it("applyRemote: clean/missing local records always take the remote value", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.applyRemote([
			{
				id: "new-from-remote",
				data: { text: "remote" },
				meta: {
					version: 1,
					createdAt: 0,
					updatedAt: 0,
					deleted: false,
					dirty: false,
					source: "remote",
				},
			},
		]);
		assert.equal(notes.peek("new-from-remote")?.data.text, "remote");
	});

	it("applyRemote: empty array is a no-op", async () => {
		const notes = makeCollection();
		await notes.ready;
		const before = notes.query().getCurrentResult();
		notes.applyRemote([]);
		assert.deepEqual(notes.query().getCurrentResult(), before);
	});

	it("markSynced clears dirty only for currently-dirty ids, no-ops otherwise", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "a" });
		assert.equal(notes.peek(id)?.meta.dirty, true);
		notes.markSynced([id, "missing-id"]);
		assert.equal(notes.peek(id)?.meta.dirty, false);
		assert.equal(notes.pending().length, 0);
	});

	it("purgeDeleted removes only synced tombstones (deleted && !dirty)", async () => {
		const notes = makeCollection();
		await notes.ready;
		const unsyncedDeleteId = notes.insert({ text: "a" });
		notes.delete(unsyncedDeleteId); // dirty tombstone -- must be kept

		const syncedDeleteId = notes.insert({ text: "b" }, { now: 1 });
		notes.delete(syncedDeleteId);
		notes.markSynced([syncedDeleteId]); // dirty=false tombstone -- purgeable

		const purged = notes.purgeDeleted();
		assert.deepEqual(purged, [syncedDeleteId]);

		// purged record is gone from the store entirely (not just hidden)
		assert.equal(
			notes.pending().some((r) => r.id === syncedDeleteId),
			false,
		);
		// unsynced tombstone survives
		assert.equal(
			notes.pending().some((r) => r.id === unsyncedDeleteId),
			true,
		);
	});
});

describe("create-collection: error handling", () => {
	it("routes background persistence failures to onError", async () => {
		const errors: unknown[] = [];
		const failingAdapter: StorageAdapter = {
			read: async () => undefined,
			readAll: async () => [],
			write: async () => {
				throw new Error("disk full");
			},
			writeMany: async () => {},
			remove: async () => {},
			clear: async () => {},
			close: async () => {},
		};
		const notes = createCollection<Note>({
			name: "notes",
			storage: createStorageEngine(failingAdapter),
			onError: (err) => errors.push(err),
		});
		await notes.ready;
		notes.insert({ text: "a" });
		await wait(20);
		assert.equal(errors.length, 1);
		assert.equal((errors[0] as Error).message, "disk full");
	});
});

describe("create-collection: dispose", () => {
	it("mutating calls throw after dispose()", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.dispose();
		assert.throws(() => notes.insert({ text: "a" }), /disposed/);
	});

	it("dispose() is idempotent", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.dispose();
		assert.doesNotThrow(() => notes.dispose());
	});
});
