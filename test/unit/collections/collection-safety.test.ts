import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollectionErrorInfo } from "../../../src/collections/collection-types.js";
import { createCollection } from "../../../src/collections/create-collection.js";
import type { Entry } from "../../../src/crdt/lww-map.js";
import { fromGuard, valid } from "../../../src/records/record-validation.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
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
		storage: createMemoryAdapter(),
		writerId: async () => "me",
		...overrides,
	});
}

const remote = (value: unknown, stamp = 5): Entry<Note> => ({
	value: value as Note,
	deleted: false,
	stamp,
	device: "other",
});

/** A memory adapter holding `seed`, whose first readAll() (loading) waits until released. */
async function makeSlowLoadAdapter(seed: Record<string, Note>) {
	const inner = createMemoryAdapter();
	await inner.merge(
		"notes",
		new Map(Object.entries(seed).map(([k, v]) => [k, { entry: remote(v) }])),
	);
	const gate = createDeferred<void>();
	const adapter: StorageAdapter = {
		...inner,
		async readAll(collection) {
			await gate.promise;
			return inner.readAll(collection);
		},
	};
	return { adapter, inner, release: () => gate.resolve() };
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
			record.meta.stamp = 0;
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
			storage: createMemoryAdapter(),
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
	it("is a no-op (no new entry, no notification) when the value is unchanged", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.upsert("k", { text: "same" });
		const before = notes.peek("k");
		let notified = 0;
		notes.subscribe(() => notified++);
		notes.upsert("k", { text: "same" });
		assert.equal(notes.peek("k"), before);
		assert.equal(notified, 0);
	});

	it("restores a deleted record", async () => {
		const notes = makeCollection();
		await notes.ready;
		notes.upsert("k", { text: "one" });
		notes.delete("k");
		notes.upsert("k", { text: "one" });
		assert.equal(notes.peek("k")?.data.text, "one");
	});
});

describe("collection safety: writes before loading completes", () => {
	it("every write before loading finishes throws a clear 'await ready' error, and changes nothing", async () => {
		const slow = await makeSlowLoadAdapter({ k: { text: "stored" } });
		const notes = makeCollection({ storage: slow.adapter });
		assert.equal(notes.hydrated, false);
		assert.throws(() => notes.insert({ text: "x" }), /await app.ready/);
		assert.throws(() => notes.upsert("k", { text: "x" }), /await app.ready/);
		assert.throws(() => notes.update("k", { text: "x" }), /await app.ready/);
		assert.throws(() => notes.replace("k", { text: "x" }), /await app.ready/);
		assert.throws(() => notes.delete("k"), /await app.ready/);
		slow.release();
		await notes.ready;
		assert.equal(notes.hydrated, true);
		assert.equal(notes.peek("k")?.data.text, "stored");
		notes.delete("k"); // fine once loaded
		assert.equal(notes.peek("k"), undefined);
	});

	it("a failed load is reported, and later edits say loading failed (not 'still loading')", async () => {
		const errors: CollectionErrorInfo[] = [];
		const notes = makeCollection({
			storage: {
				...createMemoryAdapter(),
				readAll: async () => {
					throw new Error("disk unavailable");
				},
			},
			onError: (_error, info) => errors.push(info),
		});
		await assert.rejects(notes.load(), /disk unavailable/);
		assert.deepEqual(errors, [{ source: "storage", collection: "notes" }]);
		assert.throws(
			() => notes.update("k", { text: "x" }),
			/loading from storage failed/,
		);
	});

	it("a failed load is retried by load() and by `ready`: writes work after", async () => {
		const inner = createMemoryAdapter();
		await inner.merge(
			"notes",
			new Map([["k", { entry: remote({ text: "stored" }) }]]),
		);
		let failures = 2;
		const notes = makeCollection({
			storage: {
				...inner,
				readAll: async (collection) => {
					if (failures-- > 0) throw new Error("disk unavailable");
					return inner.readAll(collection);
				},
			},
			onError: () => {},
		});
		await assert.rejects(notes.load(), /disk unavailable/);
		await assert.rejects(notes.ready, /disk unavailable/);
		await notes.ready;
		assert.equal(notes.peek("k")?.data.text, "stored");
		notes.upsert("k", { text: "after the retry" });
		await notes.whenPersisted();
		assert.deepEqual((await inner.readAll("notes")).get("k")?.entry.value, {
			text: "after the retry",
		});
	});

	it("whenPersisted() resolves only after queued writes have landed", async () => {
		const inner = createMemoryAdapter();
		const gate = createDeferred<void>();
		const notes = makeCollection({
			storage: {
				...inner,
				async merge(collection, changes) {
					await gate.promise;
					return inner.merge(collection, changes);
				},
			},
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
		assert.ok((await inner.readAll("notes")).has(id));
	});
});

describe("collection safety: values from elsewhere", () => {
	const isNote = (d: unknown): d is Note =>
		typeof d === "object" && d !== null && typeof (d as Note).text === "string";

	it("an invalid incoming value is kept but hidden, and reported once", async () => {
		const errors: CollectionErrorInfo[] = [];
		const notes = makeCollection({
			validator: fromGuard(isNote, "not a note"),
			onError: (_e, info) => errors.push(info),
		});
		await notes.ready;
		notes.mergeRemote(
			new Map([
				["bad", remote({ nope: 1 })],
				["good", remote({ text: "ok" })],
			]),
			{ synced: true },
		);
		assert.equal(notes.peek("bad"), undefined);
		assert.equal(notes.peek("good")?.data.text, "ok");
		assert.deepEqual(
			notes
				.query()
				.getCurrentResult()
				.map((r) => r.id),
			["good"],
		);
		// Kept, so this device still agrees with the others about what the key holds.
		assert.deepEqual(notes.snapshot().get("bad")?.value, { nope: 1 });
		assert.deepEqual(errors, [
			{ source: "remote-validation", collection: "notes", id: "bad" },
		]);
		// A valid newer value shows again.
		notes.mergeRemote(new Map([["bad", remote({ text: "fixed" }, 9)]]));
		assert.equal(notes.peek("bad")?.data.text, "fixed");
	});

	it("local writes are validated, and invalid ones throw", async () => {
		const notes = makeCollection({
			validator: fromGuard(isNote, "not a note"),
		});
		await notes.ready;
		assert.throws(
			() => notes.upsert("k", { nope: 1 } as unknown as Note),
			/not a note/,
		);
		assert.equal(notes.snapshot().size, 0);
	});

	it("a validator's output isn't frozen in place, so it may reuse shared objects (e.g. defaults)", async () => {
		const DEFAULT_TAGS: string[] = [];
		const notes = makeCollection({
			validator: (d) => valid({ ...(d as Note), tags: DEFAULT_TAGS }),
		});
		await notes.ready;
		notes.mergeRemote(new Map([["r", remote({ text: "from the server" })]]));
		assert.equal(Object.isFrozen(notes.peek("r")?.data.tags), true); // stored copy: frozen
		assert.equal(Object.isFrozen(DEFAULT_TAGS), false); // the validator's own: untouched
		DEFAULT_TAGS.push("still usable");
	});
});

describe("collection safety: replaceAll (source snapshots)", () => {
	it("writes changed values, keeps unchanged entries, and removes the rest from storage", async () => {
		const inner = createMemoryAdapter();
		const notes = makeCollection({ storage: inner });
		await notes.ready;
		notes.replaceAll(
			new Map([
				["a", { text: "a" }],
				["b", { text: "b" }],
			]),
		);
		const a = notes.peek("a");
		notes.replaceAll(
			new Map([
				["a", { text: "a" }],
				["c", { text: "c" }],
			]),
		);
		assert.equal(notes.peek("a"), a); // unchanged: same entry
		assert.equal(notes.peek("b"), undefined);
		await notes.whenPersisted();
		assert.deepEqual([...(await inner.readAll("notes")).keys()].sort(), [
			"a",
			"c",
		]);
	});
});
