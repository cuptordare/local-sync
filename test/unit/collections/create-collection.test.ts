import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollection } from "../../../src/collections/create-collection.js";
import { createHybridClock } from "../../../src/crdt/hlc.js";
import type { Entry } from "../../../src/crdt/lww-map.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";

interface Note {
	text: string;
	done?: boolean;
}

function makeCollection(
	overrides: Partial<Parameters<typeof createCollection<Note>>[0]> = {},
) {
	return createCollection<Note>({
		name: "notes",
		storage: createMemoryAdapter(),
		writerId: async () => "me",
		...overrides,
	});
}

const entry = (
	text: string | null,
	stamp: number,
	device = "other",
): Entry<Note> => ({
	value: text === null ? null : { text },
	deleted: text === null,
	stamp,
	device,
});

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("create-collection: CRUD", () => {
	it("insert() returns an id and applies synchronously", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "hello" });
		assert.equal(typeof id, "string");
		assert.deepEqual(notes.peek(id)?.data, { text: "hello" });
	});

	it("insert() with an explicit id uses that id, and throws if a record is there", async () => {
		const notes = makeCollection();
		await notes.ready;
		assert.equal(notes.insert({ text: "a" }, { id: "x" }), "x");
		assert.throws(
			() => notes.insert({ text: "b" }, { id: "x" }),
			/already exists/,
		);
		notes.delete("x");
		notes.insert({ text: "c" }, { id: "x" }); // a deleted record can be inserted again
		assert.equal(notes.peek("x")?.data.text, "c");
	});

	it("update() shallow-merges; update() and replace() throw if the record is missing", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "a" });
		notes.update(id, { done: true });
		assert.deepEqual(notes.peek(id)?.data, { text: "a", done: true });
		notes.replace(id, { text: "b" });
		assert.deepEqual(notes.peek(id)?.data, { text: "b" });
		assert.throws(() => notes.update("nope", { text: "x" }), /missing record/);
		assert.throws(() => notes.replace("nope", { text: "x" }), /missing record/);
		notes.delete(id);
		assert.throws(() => notes.update(id, { text: "x" }), /missing record/);
	});

	it("each write is a new entry stamped later than the last, by this tab", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.upsert("k", { text: "one" });
		const first = notes.peek("k")?.meta;
		notes.upsert("k", { text: "two" });
		const second = notes.peek("k")?.meta;
		assert.ok(first && second && second.stamp > first.stamp);
		assert.equal(second.device, "me");
	});

	it("delete() keeps a tombstone; it's a no-op on missing or deleted records", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.delete("missing");
		assert.equal(notes.snapshot().size, 0);
		const id = notes.insert({ text: "a" });
		notes.delete(id);
		const tombstone = notes.snapshot().get(id);
		assert.equal(tombstone?.deleted, true);
		assert.equal(tombstone?.value, null);
		notes.delete(id);
		assert.equal(notes.snapshot().get(id), tombstone);
	});
});

describe("create-collection: reads", () => {
	it("peek()/get()/query() hide deleted records", async () => {
		const notes = makeCollection();
		await notes.ready;
		const id = notes.insert({ text: "a" });
		notes.delete(id);
		assert.equal(notes.peek(id), undefined);
		assert.equal(notes.get(id).getCurrentResult(), undefined);
		assert.deepEqual(notes.query().getCurrentResult(), []);
	});

	it("get(id) returns the same cached query, reactive to that record", async () => {
		const notes = makeCollection();
		await notes.ready;
		assert.equal(notes.get("a"), notes.get("a"));
		const seen: Array<string | undefined> = [];
		notes.get("a").subscribe((r) => seen.push(r?.data.text));
		notes.upsert("a", { text: "one" });
		notes.upsert("b", { text: "other" });
		notes.upsert("a", { text: "two" });
		assert.deepEqual(seen, ["one", "two"]);
	});

	it("query(predicate) filters and stays live", async () => {
		const notes = makeCollection();
		await notes.ready;
		const long = notes.query((n) => n.text.length > 3);
		const seen: string[][] = [];
		long.subscribe((rows) => seen.push(rows.map((r) => r.data.text)));
		notes.upsert("a", { text: "short" });
		notes.upsert("b", { text: "no" });
		notes.upsert("a", { text: "x" });
		assert.deepEqual(seen, [["short"], []]);
	});

	it("reports deletes as 'deleted' changes, and live values as 'set'", async () => {
		const notes = makeCollection();
		await notes.ready;
		const kinds: string[] = [];
		notes.subscribe(({ changes }) => {
			for (const c of changes)
				kinds.push(`${c.kind}:${c.record?.data.text ?? ""}`);
		});
		notes.upsert("a", { text: "x" });
		notes.delete("a");
		assert.deepEqual(kinds, ["set:x", "deleted:"]);
	});
});

describe("create-collection: persistence", () => {
	it("stores the latest value even when an earlier storage write is slow", async () => {
		const inner = createMemoryAdapter();
		let calls = 0;
		const storage: StorageAdapter = {
			...inner,
			async merge(collection, changes) {
				// The first write lands last.
				await wait(++calls === 1 ? 30 : 1);
				return inner.merge(collection, changes);
			},
		};
		const notes = makeCollection({ storage });
		await notes.ready;
		notes.upsert("k", { text: "one" });
		await Promise.resolve(); // separate storage writes
		await wait(5);
		notes.upsert("k", { text: "two" });
		await wait(60);
		await notes.whenPersisted();
		const stored = await inner.readAll("notes");
		assert.deepEqual(stored.get("k")?.entry.value, { text: "two" });
	});

	it("a burst of writes is one storage write", async () => {
		const inner = createMemoryAdapter();
		let merges = 0;
		const notes = makeCollection({
			storage: {
				...inner,
				merge: (c, changes) => {
					merges++;
					return inner.merge(c, changes);
				},
			},
		});
		await notes.ready;
		notes.upsert("a", { text: "1" });
		notes.upsert("b", { text: "2" });
		notes.upsert("a", { text: "3" });
		await notes.whenPersisted();
		assert.equal(merges, 1);
		assert.equal((await inner.readAll("notes")).size, 2);
	});

	it("loads stored entries, and stamps new writes after them", async () => {
		const storage = createMemoryAdapter();
		const future = Date.now() * 1000 + 10_000_000;
		await storage.merge(
			"notes",
			new Map([["k", { entry: entry("stored", future) }]]),
		);
		const notes = makeCollection({ storage, clock: createHybridClock() });
		await notes.ready;
		assert.equal(notes.peek("k")?.data.text, "stored");
		notes.upsert("k", { text: "mine" });
		assert.ok((notes.peek("k")?.meta.stamp ?? 0) > future);
	});

	it("routes failed storage writes to onError, and writes them with the next change", async () => {
		const inner = createMemoryAdapter();
		let fail = true;
		const errors: string[] = [];
		const notes = makeCollection({
			storage: {
				...inner,
				async merge(collection, changes) {
					if (fail) throw new Error("disk full");
					return inner.merge(collection, changes);
				},
			},
			onError: (error, info) => errors.push(`${info.source}: ${String(error)}`),
		});
		await notes.ready;
		notes.upsert("a", { text: "1" });
		await notes.whenPersisted();
		assert.deepEqual(errors, ["storage: Error: disk full"]);
		fail = false;
		notes.upsert("b", { text: "2" });
		await notes.whenPersisted();
		assert.deepEqual([...(await inner.readAll("notes")).keys()].sort(), [
			"a",
			"b",
		]);
	});
});

describe("create-collection: sync integration", () => {
	it("pending() lists keys with writes the remote isn't known to hold", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.upsert("a", { text: "1" });
		notes.upsert("b", { text: "2" });
		notes.delete("b");
		assert.deepEqual(notes.pending().sort(), ["a", "b"]);
		notes.mergeRemote(
			new Map([["a", notes.snapshot().get("a") as Entry<Note>]]),
			{
				synced: true,
			},
		);
		assert.deepEqual(notes.pending(), ["b"]);
	});

	it("mergeRemote keeps the newer entry per key, whatever arrives when", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.mergeRemote(new Map([["k", entry("newer", 20)]]), { synced: true });
		notes.mergeRemote(new Map([["k", entry("older", 10)]]), { synced: true }); // a stale pull
		assert.equal(notes.peek("k")?.data.text, "newer");
		assert.deepEqual(notes.pending(), []);
	});

	it("a local write made after seeing remote data beats it, and stays pending", async () => {
		const notes = makeCollection({ clock: createHybridClock(() => 1) }); // wall clock far behind
		await notes.ready;
		notes.mergeRemote(new Map([["k", entry("theirs", 5_000_000)]]), {
			synced: true,
		});
		notes.upsert("k", { text: "mine" });
		notes.mergeRemote(new Map([["k", entry("theirs", 5_000_000)]]), {
			synced: true,
		});
		assert.equal(notes.peek("k")?.data.text, "mine");
		assert.deepEqual(notes.pending(), ["k"]);
	});

	it("merging the same thing again changes nothing (no notification, no storage write)", async () => {
		const inner = createMemoryAdapter();
		let merges = 0;
		const notes = makeCollection({
			storage: {
				...inner,
				merge: (c, changes) => {
					merges++;
					return inner.merge(c, changes);
				},
			},
		});
		await notes.ready;
		const remote = new Map([["k", entry("x", 7)]]);
		notes.mergeRemote(remote, { synced: true });
		await notes.whenPersisted();
		let notified = 0;
		notes.subscribe(() => notified++);
		notes.mergeRemote(remote, { synced: true });
		await notes.whenPersisted();
		assert.equal(notified, 0);
		assert.equal(merges, 1);
	});

	it("mergeFromTab takes in another tab's stored entries without writing them again", async () => {
		const inner = createMemoryAdapter();
		let merges = 0;
		const notes = makeCollection({
			storage: {
				...inner,
				merge: (c, changes) => {
					merges++;
					return inner.merge(c, changes);
				},
			},
		});
		await notes.ready;
		notes.mergeFromTab(
			new Map([
				[
					"k",
					{
						entry: entry("from tab", 9),
						synced: { stamp: 9, device: "other" },
					},
				],
			]),
			[],
		);
		await notes.whenPersisted();
		assert.equal(notes.peek("k")?.data.text, "from tab");
		assert.deepEqual(notes.pending(), []);
		assert.equal(merges, 0);
	});

	it("tab messages arriving before loading finishes are kept", async () => {
		const inner = createMemoryAdapter();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const notes = makeCollection({
			storage: {
				...inner,
				async readAll(c) {
					await gate;
					return inner.readAll(c);
				},
			},
		});
		notes.mergeFromTab(new Map([["k", { entry: entry("early", 9) }]]), []);
		release();
		await notes.ready;
		assert.equal(notes.peek("k")?.data.text, "early");
	});
});

describe("create-collection: dispose", () => {
	it("mutating calls throw after dispose(), which is idempotent", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.dispose();
		notes.dispose();
		assert.throws(() => notes.insert({ text: "x" }), /disposed/);
	});
});
