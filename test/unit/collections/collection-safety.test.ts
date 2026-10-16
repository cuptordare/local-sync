import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollectionErrorInfo } from "../../../src/collections/collection-types.js";
import { createCollection } from "../../../src/collections/create-collection.js";
import type { RecordEnvelope } from "../../../src/records/record-envelope.js";
import { lastWriteWins } from "../../../src/records/record-merge.js";
import { invalid, valid } from "../../../src/records/record-validation.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";
import { createDeferred } from "../support/fake-sync-adapter.js";

interface Note {
	text: string;
	tags?: string[];
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

function remote(
	id: string,
	data: Note,
	meta: Partial<RecordEnvelope<Note>["meta"]> = {},
): RecordEnvelope<Note> {
	return {
		id,
		data,
		meta: {
			version: 1,
			createdAt: 0,
			updatedAt: 0,
			deleted: false,
			dirty: false,
			source: "remote",
			...meta,
		},
	};
}

/** A memory adapter whose first readAll() (hydration) waits until released. */
function makeSlowHydrationAdapter(seed: RecordEnvelope<Note>[]) {
	const inner = createMemoryAdapter();
	const gate = createDeferred<void>();
	const adapter: StorageAdapter = {
		...inner,
		async readAll(collection) {
			await gate.promise;
			return inner.readAll(collection);
		},
	};
	return {
		adapter,
		seed: () => inner.writeMany("notes", seed),
		release: () => gate.resolve(),
	};
}

describe("collection safety: frozen, private data", () => {
	it("read results are frozen, so accidental mutation throws instead of silently corrupting state", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hi", tags: ["a"] });
		const record = notes.peek(id);
		assert.ok(record);
		assert.throws(() => {
			(record.data as Note).text = "changed";
		}, TypeError);
		assert.throws(() => {
			record.data.tags?.push("b");
		}, TypeError);
		assert.throws(() => {
			record.meta.dirty = false;
		}, TypeError);
		assert.equal(notes.peek(id)?.data.text, "hi");
	});

	it("insert() keeps a private copy: mutating the caller's object afterwards changes nothing", async () => {
		const notes = makeCollection();
		await notes.ready;
		const input = { text: "hi", tags: ["a"] };
		const id = notes.insert(input);
		input.text = "mutated";
		input.tags.push("b");
		assert.deepEqual(notes.peek(id)?.data, { text: "hi", tags: ["a"] });
		assert.equal(Object.isFrozen(input), false); // the caller's object is left alone
	});

	it("typed arrays can be stored (they can't be frozen, so they're left as-is)", async () => {
		const files = createCollection<{ bytes: Uint8Array }>({
			name: "files",
			storage: createStorageEngine(createMemoryAdapter()),
		});
		await files.ready;
		const id = files.insert({ bytes: new Uint8Array([1, 2, 3]) });
		assert.deepEqual([...(files.peek(id)?.data.bytes ?? [])], [1, 2, 3]);
	});

	it("non-storable values fail at write time, not later in a background storage write", async () => {
		const notes = makeCollection();
		await notes.ready;
		assert.throws(() =>
			notes.insert({ text: "x", fn: () => {} } as unknown as Note),
		);
	});
});

describe("collection safety: upsert", () => {
	it("inserts when missing and replaces when present", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.upsert("k", { text: "one" });
		assert.equal(notes.peek("k")?.meta.version, 1);
		notes.upsert("k", { text: "two" });
		assert.equal(notes.peek("k")?.data.text, "two");
		assert.equal(notes.peek("k")?.meta.version, 2);
	});

	it("is a no-op (no version bump, no notification) when the value is unchanged", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.upsert("k", { text: "same" });
		let notified = 0;
		notes.subscribe(() => notified++);
		notes.upsert("k", { text: "same" });
		assert.equal(notes.peek("k")?.meta.version, 1);
		assert.equal(notified, 0);
	});

	it("restores a soft-deleted record", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.upsert("k", { text: "one" });
		notes.delete("k");
		notes.upsert("k", { text: "one" });
		assert.equal(notes.peek("k")?.data.text, "one");
		assert.equal(notes.peek("k")?.meta.deleted, false);
	});
});

describe("collection safety: writes before hydration completes", () => {
	it("every write before loading finishes throws a clear 'await ready' error, and changes nothing", async () => {
		const slow = makeSlowHydrationAdapter([remote("k", { text: "stored" })]);
		await slow.seed();
		const notes = makeCollection({
			storage: createStorageEngine(slow.adapter),
		});
		assert.equal(notes.hydrated, false);
		assert.throws(() => notes.insert({ text: "x" }), /await app.ready/);
		assert.throws(
			() => notes.insert({ text: "x" }, { id: "k" }),
			/await app.ready/,
		);
		assert.throws(() => notes.upsert("k", { text: "x" }), /await app.ready/);
		assert.throws(() => notes.update("k", { text: "x" }), /await app.ready/);
		assert.throws(() => notes.replace("k", { text: "x" }), /await app.ready/);
		assert.throws(() => notes.delete("k"), /await app.ready/);
		slow.release();
		await notes.ready;
		assert.equal(notes.hydrated, true);
		assert.equal(notes.peek("k")?.data.text, "stored");
		assert.deepEqual(notes.pending(), []);
		notes.delete("k"); // fine once loaded
		assert.equal(notes.peek("k"), undefined);
	});

	it("a failed load is reported, and later edits say loading failed (not 'still loading')", async () => {
		const errors: CollectionErrorInfo[] = [];
		const notes = makeCollection({
			storage: createStorageEngine({
				...createMemoryAdapter(),
				readAll: async () => {
					throw new Error("disk unavailable");
				},
			}),
			onError: (_error, info) => errors.push(info),
		});
		await assert.rejects(notes.ready, /disk unavailable/);
		assert.deepEqual(errors, [{ source: "storage", collection: "notes" }]);
		assert.throws(
			() => notes.update("k", { text: "x" }),
			/loading from storage failed/,
		);
	});

	it("whenPersisted() resolves only after queued writes have landed", async () => {
		const inner = createMemoryAdapter();
		const gate = createDeferred<void>();
		const notes = makeCollection({
			storage: createStorageEngine({
				...inner,
				async write(collection, record) {
					await gate.promise;
					return inner.write(collection, record);
				},
			}),
		});
		await notes.ready;
		const id = notes.insert({ text: "x" });
		let persisted = false;
		const waiting = notes.whenPersisted().then(() => {
			persisted = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(persisted, false);
		gate.resolve();
		await waiting;
		assert.ok(await inner.read("notes", id));
	});
});

describe("collection safety: applying remote data", () => {
	it("normalizes remote records even if the adapter forgot to (never pushed back as local edits)", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.applyRemote([
			remote("r", { text: "x" }, { dirty: true, source: "local", version: 3 }),
		]);
		const record = notes.peek("r");
		assert.equal(record?.meta.dirty, false);
		assert.equal(record?.meta.source, "remote");
		assert.equal(record?.meta.remoteVersion, 3);
		assert.equal(notes.pending().length, 0);
	});

	it("skips records identical to the local copy (no write, no notification)", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.applyRemote([remote("r", { text: "x" })]);
		let notified = 0;
		notes.subscribe(() => notified++);
		notes.applyRemote([remote("r", { text: "x" })]);
		assert.equal(notified, 0);
		notes.applyRemote([remote("r", { text: "y" }, { version: 2 })]);
		assert.equal(notified, 1);
		assert.equal(notes.peek("r")?.data.text, "y");
	});

	it("still records a newer remote version even when the data is identical", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.applyRemote([remote("r", { text: "x" }, { version: 1 })]);
		const before = notes.peek("r")?.data;
		notes.applyRemote([remote("r", { text: "x" }, { version: 4 })]);
		assert.equal(notes.peek("r")?.meta.remoteVersion, 4);
		// Same content keeps the same data object, so value watchers see no change.
		assert.equal(notes.peek("r")?.data, before);
	});

	it("validates remote records: invalid ones are skipped and reported, valid ones applied", async () => {
		const errors: Array<{ error: unknown; info: CollectionErrorInfo }> = [];
		const notes = makeCollection({
			validator: (d) =>
				typeof (d as Note).text === "string"
					? valid(d as Note)
					: invalid("text must be a string"),
			onError: (error, info) => errors.push({ error, info }),
		});
		await notes.ready;
		notes.applyRemote([
			remote("good", { text: "ok" }),
			remote("bad", { nope: true } as unknown as Note),
		]);
		assert.equal(notes.peek("good")?.data.text, "ok");
		assert.equal(notes.peek("bad"), undefined);
		assert.equal(errors.length, 1);
		assert.deepEqual(errors[0]?.info, {
			source: "remote-validation",
			collection: "notes",
			id: "bad",
		});
	});

	it("a merge that keeps the local edit is stamped with the remote version and supersedes it", async () => {
		const notes = makeCollection({ merge: lastWriteWins<Note>() });
		await notes.ready;
		notes.applyRemote([remote("r", { text: "base" }, { version: 1 })]);
		notes.update("r", { text: "mine" }, { now: 50 }); // version 2, remoteVersion 1
		notes.update("r", { text: "mine2" }, { now: 60 }); // version 3, remoteVersion 1
		// Someone else's edit reached the server as version 2.
		notes.applyRemote([
			remote("r", { text: "theirs" }, { version: 2, updatedAt: 10 }),
		]);
		const record = notes.peek("r");
		assert.equal(record?.data.text, "mine2"); // lastWriteWins kept local (version 3 > 2)
		assert.equal(record?.meta.dirty, true);
		assert.equal(record?.meta.remoteVersion, 2);
		assert.ok((record?.meta.version ?? 0) > 2);
	});

	it("markSynced records the acknowledged version as the remote version", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "x" });
		notes.update(id, { text: "y" });
		notes.markSynced([id]);
		assert.equal(notes.peek(id)?.meta.remoteVersion, 2);
	});

	it("removeUnseen hard-removes clean records missing from a snapshot, but keeps local edits", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.applyRemote([
			remote("keep", { text: "a" }),
			remote("gone", { text: "b" }),
			remote("edited", { text: "c" }),
		]);
		notes.update("edited", { text: "local edit" });
		const removed = notes.removeUnseen(new Set(["keep"]));
		assert.deepEqual(removed, ["gone"]);
		assert.ok(notes.peek("keep"));
		assert.equal(notes.peek("gone"), undefined);
		assert.equal(notes.peek("edited")?.data.text, "local edit");
	});
});

describe("collection safety: loading edge cases", () => {
	it("a failed load is retried by load(): writes are refused until then, and work after", async () => {
		const inner = createMemoryAdapter();
		await inner.writeMany("notes", [remote("k", { text: "stored" })]);
		let failures = 1;
		const notes = makeCollection({
			storage: createStorageEngine({
				...inner,
				readAll: async (collection) => {
					if (failures-- > 0) throw new Error("disk unavailable");
					return inner.readAll(collection);
				},
			}),
			onError: () => {},
		});
		await assert.rejects(notes.ready, /disk unavailable/);
		assert.throws(
			() => notes.insert({ text: "x" }),
			/loading from storage failed/,
		);
		await notes.load();
		assert.equal(notes.hydrated, true);
		assert.equal(notes.peek("k")?.data.text, "stored"); // the stored record is back
		const id = notes.insert({ text: "after the retry" });
		await notes.whenPersisted();
		assert.equal(
			((await inner.read("notes", id))?.data as Note | undefined)?.text,
			"after the retry",
		);
	});

	it("a refresh requested while loading runs once loading has finished", async () => {
		const slow = makeSlowHydrationAdapter([remote("k", { text: "stored" })]);
		await slow.seed();
		const notes = makeCollection({
			storage: createStorageEngine(slow.adapter),
		});
		const refreshed = notes.refreshFromStorage(["k"]); // e.g. another tab announced "k"
		await slow.adapter.write(
			"notes",
			remote("k", { text: "from another tab" }, { version: 2 }),
		);
		slow.release();
		await refreshed;
		assert.equal(notes.hydrated, true);
		assert.equal(notes.peek("k")?.data.text, "from another tab");
	});

	it("removes many records in one storage batch", async () => {
		const inner = createMemoryAdapter();
		await inner.writeMany("notes", [
			remote("a", { text: "a" }),
			remote("b", { text: "b" }),
			remote("c", { text: "c" }),
		]);
		const batches: string[][] = [];
		let singleRemoves = 0;
		const notes = makeCollection({
			storage: createStorageEngine({
				...inner,
				async remove(collection, id) {
					singleRemoves++;
					return inner.remove(collection, id);
				},
				async removeMany(collection, ids) {
					batches.push([...ids]);
					return inner.removeMany?.(collection, ids);
				},
			}),
		});
		await notes.ready;
		notes.removeUnseen(new Set());
		await notes.whenPersisted();
		assert.deepEqual(batches, [["a", "b", "c"]]);
		assert.equal(singleRemoves, 0);
		assert.deepEqual(await inner.readAll("notes"), []);
	});
});
