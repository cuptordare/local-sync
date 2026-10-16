import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollection } from "../../../src/collections/create-collection.js";
import type { RecordEnvelope } from "../../../src/records/record-envelope.js";
import { lastWriteWins } from "../../../src/records/record-merge.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";
import { createBlobSyncAdapter } from "../../../src/sync/adapters/blob-sync-adapter.js";
import { createSyncEngine } from "../../../src/sync/create-sync-engine.js";
import type {
	PushResult,
	SyncAdapter,
} from "../../../src/sync/sync-adapter.js";
import { createFakeBlobServer } from "../support/fake-blob-server.js";
import { createInstantSleep } from "../support/fake-clock.js";
import { createDeferred } from "../support/fake-sync-adapter.js";

interface Item {
	n: number;
}

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function rec(id: string, n = 1): RecordEnvelope<Item> {
	return {
		id,
		data: { n },
		meta: {
			version: 1,
			createdAt: 0,
			updatedAt: 0,
			deleted: false,
			dirty: false,
			source: "remote",
		},
	};
}

async function makeCollection(storage = createMemoryAdapter()) {
	const collection = createCollection<Item>({
		name: "items",
		storage: createStorageEngine(storage),
	});
	await collection.ready;
	return collection;
}

describe("sync engine: overlapping pulls", () => {
	it("a filter change during a slow pull ends with the NEW filter's data", async () => {
		const collection = await makeCollection();
		const calls: unknown[] = [];
		const engine = createSyncEngine<Item, string>({
			collection,
			filter: "old",
			adapter: {
				async pull({ filter }) {
					calls.push(filter);
					await wait(filter === "old" ? 40 : 5); // the old-filter pull is the slow one
					return {
						records: [rec(filter === "old" ? "old-1" : "new-1")],
						complete: true,
					};
				},
			},
			sleep: createInstantSleep(),
		});
		const first = engine.pull();
		engine.setFilter("new");
		const second = engine.pull();
		await Promise.all([first, second]);
		assert.deepEqual(
			collection
				.query()
				.getCurrentResult()
				.map((r) => r.id),
			["new-1"],
		);
		assert.deepEqual(calls, ["old", "new"]); // one at a time, newest filter last
	});

	it("pulls never overlap (e.g. a manual refresh during the interval refresh)", async () => {
		const collection = await makeCollection();
		let running = 0;
		let maxRunning = 0;
		const engine = createSyncEngine({
			collection,
			adapter: {
				async pull() {
					running++;
					maxRunning = Math.max(maxRunning, running);
					await wait(10);
					running--;
					return { records: [] };
				},
			},
			sleep: createInstantSleep(),
		});
		await Promise.all([engine.pull(), engine.pull(), engine.pull()]);
		assert.equal(maxRunning, 1);
	});

	it("setFilter alone (no pull call) still re-runs a pull that was in flight", async () => {
		const collection = await makeCollection();
		const engine = createSyncEngine<Item, string>({
			collection,
			filter: "old",
			adapter: {
				async pull({ filter }) {
					await wait(10);
					return { records: [rec(`${filter}-1`)], complete: true };
				},
			},
			sleep: createInstantSleep(),
		});
		const pulling = engine.pull();
		engine.setFilter("new"); // e.g. another tab changed the filter
		await pulling;
		assert.deepEqual(
			collection
				.query()
				.getCurrentResult()
				.map((r) => r.id),
			["new-1"],
		);
	});
});

describe("sync engine: pulls racing other work", () => {
	it("a record pushed during a multi-page snapshot pull isn't removed as unseen", async () => {
		const collection = await makeCollection();
		const page2 = createDeferred<void>();
		const engine = createSyncEngine<Item, unknown, string>({
			collection,
			adapter: {
				async pull({ cursor }) {
					if (cursor === undefined) {
						return { records: [rec("a")], hasMore: true, cursor: "p2" };
					}
					await page2.promise;
					return { records: [rec("b")], complete: true };
				},
				async push(mutations) {
					return { acked: mutations.map((m) => m.mutationId) };
				},
			},
			sleep: createInstantSleep(),
		});
		const pulling = engine.pull();
		await wait();
		collection.insert({ n: 9 }, { id: "x" });
		await engine.push(); // acked: "x" is now clean, but no page of this pull has it
		assert.equal(collection.pending().length, 0);
		page2.resolve();
		await pulling;
		assert.deepEqual(
			collection
				.query()
				.getCurrentResult()
				.map((r) => r.id)
				.sort(),
			["a", "b", "x"],
		);
	});

	it("a pull for the new filter still runs when the old filter's pull fails", async () => {
		const collection = await makeCollection();
		const gate = createDeferred<void>();
		const calls: unknown[] = [];
		const engine = createSyncEngine<Item, string>({
			collection,
			filter: "old",
			adapter: {
				async pull({ filter }) {
					calls.push(filter);
					if (filter === "old") {
						await gate.promise;
						throw new Error("old filter failed");
					}
					return { records: [rec("new-1")], complete: true };
				},
			},
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		const errors: unknown[] = [];
		engine.on("sync:error", ({ error }) => errors.push(error));
		const pulling = engine.pull();
		engine.setFilter("new");
		gate.resolve();
		await pulling; // the old filter's failure no longer matters
		assert.deepEqual(calls, ["old", "new"]);
		assert.ok(collection.peek("new-1"));
		assert.deepEqual(errors, []);
		assert.equal(engine.getState().phase, "idle");
	});
});

describe("sync engine: push acknowledgements", () => {
	it("an ack doesn't mark a record synced if another tab replaced it (same version) meanwhile", async () => {
		const storage = createMemoryAdapter();
		const collection = await makeCollection(storage);
		collection.insert({ n: 1 }, { id: "k" }); // version 1, dirty
		await collection.whenPersisted();
		const pushed = createDeferred<PushResult<Item>>();
		let mutationId = "";
		const adapter: SyncAdapter<Item> = {
			pull: async () => ({ records: [] }),
			push: (mutations) => {
				mutationId = mutations[0]?.mutationId ?? "";
				return pushed.promise;
			},
		};
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		const pushing = engine.push();
		await wait(); // the push is in flight

		// Another tab writes its OWN version-1 edit of "k" to shared storage, and this tab
		// picks it up -- same version number, different content.
		const other = {
			...rec("k", 99),
			meta: { ...rec("k").meta, dirty: true, source: "local" as const },
		};
		await storage.write("items", other);
		await collection.refreshFromStorage(["k"]);
		assert.equal(collection.peek("k")?.data.n, 99);

		pushed.resolve({ acked: [mutationId] }); // acks the n=1 edit, not this one
		await pushing;
		const record = collection.pending().find((r) => r.id === "k");
		assert.ok(record, "the other tab's edit must still be pending");
		assert.equal(record?.data.n, 99);
	});
});

describe("sync engine: push and pull failures are independent", () => {
	it("sync() still pulls when the push fails, and the push failure stays visible", async () => {
		const collection = await makeCollection();
		collection.insert({ n: 1 }, { id: "local" });
		let pulled = 0;
		let pushFails = true;
		const engine = createSyncEngine({
			collection,
			adapter: {
				async pull() {
					pulled++;
					return { records: [rec("remote")] };
				},
				async push(mutations) {
					if (pushFails) throw new Error("400 bad batch");
					return { acked: mutations.map((m) => m.mutationId) };
				},
			},
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		await assert.rejects(() => engine.sync(), /400 bad batch/);
		assert.equal(pulled, 1, "others' changes still arrive");
		assert.ok(collection.peek("remote"));
		// The successful pull must not hide the failing push.
		assert.equal(engine.getState().phase, "error");
		assert.match(engine.getState().lastError ?? "", /400 bad batch/);

		pushFails = false;
		await engine.sync();
		assert.equal(engine.getState().phase, "idle");
		assert.equal(engine.getState().lastError, undefined);
	});

	it("a push failure is cleared once there's nothing left to push", async () => {
		const collection = await makeCollection();
		collection.insert({ n: 1 }, { id: "k" });
		const engine = createSyncEngine({
			collection,
			adapter: {
				pull: async () => ({ records: [] }),
				push: async () => {
					throw new Error("down");
				},
			},
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		await assert.rejects(() => engine.push());
		assert.equal(engine.getState().phase, "error");
		collection.markSynced(["k"]); // resolved some other way
		await engine.push();
		assert.equal(engine.getState().phase, "idle");
	});
});

describe("sync engine: push responses and restarts", () => {
	it("an acked record takes the server's returned copy, even if the merge strategy would keep the local edit", async () => {
		const collection = createCollection<Item>({
			name: "items",
			storage: createStorageEngine(createMemoryAdapter()),
			merge: lastWriteWins<Item>(),
		});
		await collection.ready;
		collection.insert({ n: 1 }, { id: "x", now: 1000 });
		const engine = createSyncEngine<Item>({
			collection,
			adapter: {
				pull: async () => ({ records: [] }),
				async push(mutations): Promise<PushResult<Item>> {
					// Accepted, and normalized by the server (an older timestamp than the local edit).
					return {
						acked: mutations.map((m) => m.mutationId),
						records: [
							{ ...rec("x", 99), meta: { ...rec("x").meta, updatedAt: 1 } },
						],
					};
				},
			},
			sleep: createInstantSleep(),
		});
		await engine.push();
		const record = collection.peek("x");
		assert.equal(record?.data.n, 99);
		assert.equal(record?.meta.dirty, false);
		assert.equal(record?.meta.remoteVersion, 1);
		assert.equal(record?.meta.version, 1);
	});

	it("calling start() again keeps a push that was already scheduled", async () => {
		const collection = await makeCollection();
		let pushes = 0;
		const engine = createSyncEngine<Item>({
			collection,
			adapter: {
				pull: async () => ({ records: [] }),
				async push(mutations) {
					pushes++;
					return { acked: mutations.map((m) => m.mutationId) };
				},
			},
			sleep: createInstantSleep(),
		});
		const options = { pushOnChange: { debounceMs: 20 }, syncOnStart: false };
		engine.start(options);
		collection.insert({ n: 1 });
		engine.start(options); // e.g. re-applying settings, or becoming the syncing tab again
		await wait(60);
		assert.equal(pushes, 1);
		assert.equal(collection.pending().length, 0);
		engine.dispose();
	});

	it("a pull after a failed load retries the load instead of failing forever", async () => {
		const inner = createMemoryAdapter();
		let failures = 1;
		const collection = createCollection<Item>({
			name: "items",
			storage: createStorageEngine({
				...inner,
				readAll: async (c) => {
					if (failures-- > 0) throw new Error("disk unavailable");
					return inner.readAll(c);
				},
			}),
			onError: () => {},
		});
		await assert.rejects(collection.ready);
		const engine = createSyncEngine<Item>({
			collection,
			adapter: { pull: async () => ({ records: [rec("a")] }) },
			sleep: createInstantSleep(),
		});
		await engine.pull();
		assert.equal(collection.hydrated, true);
		assert.equal(collection.peek("a")?.data.n, 1);
	});
});

describe("sync engine: lost replies", () => {
	/** A blob server whose next write is saved, but the reply never arrives. */
	function flakyServer() {
		const server = createFakeBlobServer<Item>();
		let loseNextReply = false;
		const adapter = createBlobSyncAdapter<Item>({
			read: () => server.read(),
			async write(blob, options) {
				await server.write(blob, options);
				if (loseNextReply) {
					loseNextReply = false;
					throw new Error("reply lost");
				}
			},
		});
		return {
			server,
			adapter,
			loseNextReply: () => {
				loseNextReply = true;
			},
		};
	}

	it("an edit made after a push whose reply was lost isn't discarded as a conflict", async () => {
		const { server, adapter, loseNextReply } = flakyServer();
		const collection = await makeCollection(); // serverWins, the default
		const engine = createSyncEngine<Item>({
			collection,
			adapter,
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		const conflicts: string[] = [];
		engine.on("conflict", (e) => conflicts.push(e.id));

		collection.insert({ n: 1 }, { id: "x" });
		await engine.push(); // synced once
		collection.update("x", { n: 2 });
		loseNextReply();
		await assert.rejects(engine.push(), /reply lost/); // ...but the server saved it
		collection.update("x", { n: 3 }); // edited before the next successful sync
		await engine.push();

		assert.deepEqual(server.records[0]?.data, { n: 3 });
		assert.equal(collection.peek("x")?.data.n, 3);
		assert.equal(collection.peek("x")?.meta.dirty, false);
		assert.deepEqual(conflicts, [], "this device's own save isn't a conflict");
	});

	it("a tab's stale copy of this device's own save doesn't overwrite the newer save", async () => {
		const { server, adapter } = flakyServer();
		const storage = createMemoryAdapter();
		const tab = async () => {
			const collection = createCollection<Item>({
				name: "items",
				storage: createStorageEngine(storage),
				sharedStorage: true,
			});
			await collection.ready;
			const engine = createSyncEngine<Item>({
				collection,
				adapter,
				retry: { maxAttempts: 1 },
				sleep: createInstantSleep(),
			});
			return { collection, engine };
		};
		const a = await tab();
		a.collection.insert({ n: 1 }, { id: "x" });
		await a.collection.whenPersisted();
		const b = await tab(); // loads n=1, not yet pushed
		a.collection.update("x", { n: 2 });
		await a.engine.push(); // the server has n=2, saved by this device

		await b.engine.push(); // B still holds the older n=1 (it hasn't heard of n=2)

		assert.deepEqual(server.records[0]?.data, { n: 2 });
		assert.equal(b.collection.peek("x")?.data.n, 2);
	});
});
