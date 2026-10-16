import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalSyncMergeEvent } from "../../../src/app/app-events.js";
import { createLocalSyncApp } from "../../../src/app/create-local-sync-app.js";
import type { MergeFunction } from "../../../src/crdt/merge-values.js";
import { fromGuard } from "../../../src/records/record-validation.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createBlobSyncAdapter } from "../../../src/sync/adapters/blob-sync-adapter.js";
import type { SyncAdapter } from "../../../src/sync/sync-adapter.js";
import { createFakeBlobServer } from "../support/fake-blob-server.js";
import { createFakeNetworkStatus } from "../support/fake-network-status.js";

interface Task {
	completed: boolean;
	assignedTo: string | null;
}
interface Todo {
	items: string[];
}

const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A device: its own storage, syncing only when told (so views can be stale). */
function device<T extends object>(
	remote: SyncAdapter<T>,
	options: {
		storage?: StorageAdapter;
		merge?: MergeFunction<T>;
		validator?: Parameters<typeof fromGuard<T>>[0];
		retry?: { maxAttempts: number };
	} = {},
) {
	const errors: string[] = [];
	const app = createLocalSyncApp({
		storage: options.storage ?? createMemoryAdapter(),
		network: createFakeNetworkStatus(true),
		onError: (_error, { source }) => errors.push(source),
	});
	const merges: LocalSyncMergeEvent[] = [];
	app.on("merged", (e) => merges.push(e));
	const store = app.keyValue<T>("data", {
		remote,
		autoSync: false,
		...(options.retry !== undefined ? { retry: options.retry } : {}),
		...(options.merge !== undefined ? { merge: options.merge } : {}),
		...(options.validator !== undefined
			? { validator: fromGuard(options.validator) }
			: {}),
	});
	return { app, store, merges, errors };
}

async function twoDevices<T extends object>(
	initial: Record<string, T>,
	options: Parameters<typeof device<T>>[1] = {},
) {
	const server = createFakeBlobServer<T>({ cas: true });
	const a = device<T>(createBlobSyncAdapter(server), options);
	const b = device<T>(createBlobSyncAdapter(server), options);
	await Promise.all([a.app.ready(), b.app.ready()]);
	for (const [key, value] of Object.entries(initial)) a.store.set(key, value);
	await a.app.sync();
	await b.app.sync(); // both start from the same values
	return { server, a, b };
}

describe("concurrent edits: merged, not lost", () => {
	it("an edit made from a stale view keeps the changes made meanwhile (a shared list)", async () => {
		const { server, a, b } = await twoDevices<Todo>({
			todo: { items: ["milk", "eggs"] },
		});
		a.store.set("todo", { items: ["milk", "eggs", "bread"] }); // A adds bread
		await a.app.sync();
		await wait();
		b.store.set("todo", { items: ["milk"] }); // B, still showing the old list, removes eggs
		await b.app.sync();
		await a.app.sync();
		const expected = { items: ["milk", "bread"] };
		assert.deepEqual(b.store.get("todo"), expected);
		assert.deepEqual(a.store.get("todo"), expected);
		assert.deepEqual(server.values().get("todo"), expected);
		assert.equal(b.merges.length, 1);
		assert.deepEqual(b.merges[0]?.mine, { items: ["milk"] });
	});

	it("different fields of one value changed on two devices are both kept (a bingo task)", async () => {
		const { a, b } = await twoDevices<Task>({
			"task:0-1": { completed: false, assignedTo: null },
		});
		a.store.update("task:0-1", (t) => ({ ...(t as Task), completed: true }));
		b.store.update("task:0-1", (t) => ({ ...(t as Task), assignedTo: "SW" }));
		await a.app.sync();
		await b.app.sync();
		await a.app.sync();
		const expected = { completed: true, assignedTo: "SW" };
		assert.deepEqual(a.store.get("task:0-1"), expected);
		assert.deepEqual(b.store.get("task:0-1"), expected);
	});

	it("the same field set two ways: the later edit wins, and 'keep mine' is one call", async () => {
		const { a, b } = await twoDevices<Task>({
			t: { completed: false, assignedTo: null },
		});
		b.store.set("t", { completed: false, assignedTo: "CW" });
		await wait();
		a.store.set("t", { completed: false, assignedTo: "SW" }); // the later edit
		await b.app.sync();
		await a.app.sync();
		await b.app.sync();
		assert.equal(a.store.get("t")?.assignedTo, "SW");
		assert.equal(b.store.get("t")?.assignedTo, "SW");
		// A was the one that merged; B didn't need to. B's user can still insist:
		const merge = a.merges[0];
		assert.deepEqual(merge?.theirs, { completed: false, assignedTo: "CW" });
		b.store.set("t", { completed: false, assignedTo: "CW" }); // "keep mine"
		await b.app.sync();
		await a.app.sync();
		assert.equal(a.store.get("t")?.assignedTo, "CW");
	});

	it("an app's own merge function is used, with base, mine and theirs", async () => {
		const calls: unknown[] = [];
		const keepLongest: MergeFunction<Todo> = (base, mine, theirs, { key }) => {
			calls.push({ key, base, mine, theirs });
			return mine.items.length >= theirs.items.length ? mine : theirs;
		};
		const { a, b } = await twoDevices<Todo>(
			{ todo: { items: ["x"] } },
			{ merge: keepLongest },
		);
		a.store.set("todo", { items: ["x", "a1", "a2"] });
		await a.app.sync();
		b.store.set("todo", { items: [] });
		await b.app.sync();
		await a.app.sync();
		assert.deepEqual(calls, [
			{
				key: "todo",
				base: { items: ["x"] },
				mine: { items: [] },
				theirs: { items: ["x", "a1", "a2"] },
			},
		]);
		assert.deepEqual(a.store.get("todo"), { items: ["x", "a1", "a2"] });
		assert.deepEqual(b.store.get("todo"), { items: ["x", "a1", "a2"] });
	});

	it("this device's own earlier save (reply lost) isn't merged: a later removal sticks", async () => {
		const server = createFakeBlobServer<Todo>({ cas: true });
		const blob = createBlobSyncAdapter(server);
		let loseReply = false;
		const remote: SyncAdapter<Todo> = {
			read: () => blob.read(),
			async write(entries, options) {
				const result = await blob.write(entries, options);
				if (loseReply) {
					loseReply = false;
					throw new Error("reply lost");
				}
				return result;
			},
		};
		// No retries: a retry would re-read right away and find the save.
		const d = device<Todo>(remote, { retry: { maxAttempts: 1 } });
		await d.app.ready();
		d.store.set("todo", { items: ["a"] });
		await d.app.sync();
		d.store.set("todo", { items: ["a", "b"] });
		loseReply = true;
		await d.app.sync().catch(() => {}); // saved, but this device doesn't know
		d.store.set("todo", { items: ["a"] }); // removes b again
		await d.app.sync();
		assert.deepEqual(d.store.get("todo"), { items: ["a"] });
		assert.deepEqual(server.values().get("todo"), { items: ["a"] });
		assert.equal(d.merges.length, 0);
	});

	it("an edit against a delete: no merge, the later write wins", async () => {
		const { a, b } = await twoDevices<Todo>({ todo: { items: ["x"] } });
		a.store.delete("todo");
		await a.app.sync();
		await wait();
		b.store.set("todo", { items: ["x", "y"] }); // later
		await b.app.sync();
		await a.app.sync();
		assert.deepEqual(a.store.get("todo"), { items: ["x", "y"] });
		assert.equal(a.merges.length + b.merges.length, 0);
	});

	it("a merge result the validator refuses falls back to the later write", async () => {
		// At most 2 items: each side alone is valid, their union isn't.
		const atMostTwo = (d: unknown): d is Todo =>
			Array.isArray((d as Todo).items) && (d as Todo).items.length <= 2;
		const { a, b } = await twoDevices<Todo>(
			{ todo: { items: [] } },
			{ validator: atMostTwo },
		);
		a.store.set("todo", { items: ["a1", "a2"] });
		await a.app.sync();
		await wait();
		b.store.set("todo", { items: ["b1", "b2"] }); // later
		await b.app.sync();
		await a.app.sync();
		assert.deepEqual(a.store.get("todo"), { items: ["b1", "b2"] });
		assert.deepEqual(b.store.get("todo"), { items: ["b1", "b2"] });
		assert.deepEqual(b.errors, ["merge"]);
	});

	it("a merge function that throws falls back to the later write, reported as a merge error", async () => {
		const { a, b } = await twoDevices<Todo>(
			{ todo: { items: [] } },
			{
				merge: () => {
					throw new Error("can't merge");
				},
			},
		);
		a.store.set("todo", { items: ["a"] });
		await a.app.sync();
		await wait();
		b.store.set("todo", { items: ["b"] }); // later
		await b.app.sync();
		await a.app.sync();
		assert.deepEqual(a.store.get("todo"), { items: ["b"] });
		assert.deepEqual(b.store.get("todo"), { items: ["b"] });
		assert.deepEqual(b.errors, ["merge"]);
		assert.equal(b.merges.length, 0);
	});

	it("an edit made offline is still merged after the app is reopened", async () => {
		const server = createFakeBlobServer<Todo>({ cas: true });
		const storage = createMemoryAdapter();
		const a = device<Todo>(createBlobSyncAdapter(server));
		const b = device<Todo>(createBlobSyncAdapter(server), { storage });
		await Promise.all([a.app.ready(), b.app.ready()]);
		a.store.set("todo", { items: ["milk"] });
		await a.app.sync();
		await b.app.sync();
		b.store.set("todo", { items: ["milk", "from b"] }); // offline...
		await b.app.close(); // ...and closed
		a.store.set("todo", { items: ["milk", "from a"] });
		await a.app.sync();
		const reopened = device<Todo>(createBlobSyncAdapter(server), { storage });
		await reopened.app.ready();
		await reopened.app.sync();
		await a.app.sync();
		const expected = { items: ["milk", "from b", "from a"] };
		assert.deepEqual(reopened.store.get("todo"), expected);
		assert.deepEqual(a.store.get("todo"), expected);
	});
});
