import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollection } from "../../../src/collections/create-collection.js";
import type { Entry } from "../../../src/crdt/lww-map.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createBlobSyncAdapter } from "../../../src/sync/adapters/blob-sync-adapter.js";
import { createSyncEngine } from "../../../src/sync/create-sync-engine.js";
import type { SyncAdapter } from "../../../src/sync/sync-adapter.js";
import { createFakeBlobServer } from "../support/fake-blob-server.js";
import { createInstantSleep } from "../support/fake-clock.js";
import { createFakeNetworkStatus } from "../support/fake-network-status.js";
import {
	createDeferred,
	createFakeSyncAdapter,
} from "../support/fake-sync-adapter.js";

interface Item {
	n: number;
}

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeCollection(storage: StorageAdapter = createMemoryAdapter()) {
	const collection = createCollection<Item>({
		name: "items",
		storage,
		writerId: async () => "me",
	});
	await collection.ready;
	return collection;
}

const entry = (
	n: number | null,
	stamp: number,
	device = "other",
): Entry<Item> => ({
	value: n === null ? null : { n },
	deleted: n === null,
	stamp,
	device,
});

/** A collection synced through a fake blob server (etags on). */
async function setup(
	options: { cas?: boolean; storage?: StorageAdapter } = {},
) {
	const server = createFakeBlobServer<Item>({ cas: options.cas ?? true });
	const collection = await makeCollection(options.storage);
	const engine = createSyncEngine({
		collection,
		adapter: createBlobSyncAdapter(server),
		sleep: createInstantSleep(),
	});
	return { server, collection, engine };
}

const values = (collection: Awaited<ReturnType<typeof makeCollection>>) =>
	Object.fromEntries(
		collection
			.query()
			.getCurrentResult()
			.map((r) => [r.id, r.data.n]),
	);

describe("sync engine: pull", () => {
	it("merges the remote's entries in; they aren't pending", async () => {
		const { server, collection, engine } = await setup();
		server.put({
			format: "lww-1",
			entries: { a: entry(1, 5), b: entry(null, 6) },
		});
		await engine.pull();
		assert.deepEqual(values(collection), { a: 1 });
		assert.deepEqual(collection.pending(), []);
	});

	it("keeps a local edit made after the remote's copy, and leaves it pending", async () => {
		const { server, collection, engine } = await setup();
		server.put({ format: "lww-1", entries: { a: entry(1, 5) } });
		await engine.pull();
		collection.upsert("a", { n: 2 });
		await engine.pull();
		assert.deepEqual(values(collection), { a: 2 });
		assert.deepEqual(collection.pending(), ["a"]);
	});

	it("a stale read (from before a push landed) can't roll the saved value back", async () => {
		const adapter = createFakeSyncAdapter<Item>();
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		const pulling = engine.pull(); // reads the remote: it has a=1
		await wait(1);
		adapter.resolveRead({ entries: new Map([["a", entry(1, 5)]]) });
		await pulling;
		collection.upsert("a", { n: 2 });
		const staleRead = engine.pull();
		await wait(1);
		// Meanwhile the edit is pushed elsewhere; this read still returns the old remote.
		adapter.resolveRead({ entries: new Map([["a", entry(1, 5)]]) });
		await staleRead;
		assert.deepEqual(values(collection), { a: 2 });
	});
});

describe("sync engine: push", () => {
	it("writes the merge of the remote's entries and the local ones, keeping everyone's", async () => {
		const { server, collection, engine } = await setup();
		server.put({ format: "lww-1", entries: { theirs: entry(1, 5) } });
		collection.upsert("mine", { n: 2 });
		collection.delete("gone"); // no-op: never existed
		await engine.push();
		assert.deepEqual(Object.fromEntries(server.values()), {
			theirs: { n: 1 },
			mine: { n: 2 },
		});
		assert.deepEqual(values(collection), { theirs: 1, mine: 2 });
		assert.deepEqual(collection.pending(), []);
	});

	it("pushes deletes as tombstones, so other devices learn of them", async () => {
		const { server, collection, engine } = await setup();
		collection.upsert("a", { n: 1 });
		await engine.push();
		collection.delete("a");
		await engine.push();
		assert.equal(server.entries.a?.deleted, true);
		assert.equal(server.values().size, 0);
	});

	it("doesn't write when the remote already has everything", async () => {
		const { server, collection, engine } = await setup();
		collection.upsert("a", { n: 1 });
		await engine.push();
		const writes = server.writes;
		await engine.push();
		await engine.sync();
		assert.equal(server.writes, writes);
	});

	it("is a no-op for a read-only adapter", async () => {
		const collection = await makeCollection();
		const adapter: SyncAdapter<Item> = {
			read: async () => ({ entries: new Map() }),
		};
		const engine = createSyncEngine({ collection, adapter });
		collection.upsert("a", { n: 1 });
		await engine.push();
		assert.deepEqual(collection.pending(), ["a"]);
	});

	it("an edit made while a push is in flight stays pending, and the next push saves it", async () => {
		const adapter = createFakeSyncAdapter<Item>();
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		collection.upsert("a", { n: 1 });
		const pushing = engine.push();
		await wait(1);
		adapter.resolveRead({ entries: new Map() });
		await wait(1);
		collection.upsert("a", { n: 2 }); // while the write is in flight
		adapter.resolveWrite();
		await pushing;
		assert.deepEqual(collection.pending(), ["a"]);
		assert.deepEqual(values(collection), { a: 2 });
		const sent = adapter.writes[0]?.entries.get("a");
		assert.deepEqual(sent?.value, { n: 1 });
	});

	it("a lost reply is harmless: the next push finds the write saved and needs none", async () => {
		const server = createFakeBlobServer<Item>({ cas: true });
		const blob = createBlobSyncAdapter(server);
		let loseReply = true;
		const adapter: SyncAdapter<Item> = {
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
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter,
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		collection.upsert("a", { n: 1 });
		await assert.rejects(() => engine.push(), /reply lost/);
		assert.deepEqual(collection.pending(), ["a"]); // not known to be saved
		const writes = server.writes;
		await engine.push();
		assert.equal(server.writes, writes); // it was saved: nothing to write
		assert.deepEqual(collection.pending(), []);
	});

	it("with etags, a concurrent write is merged and retried on top of it (nothing is erased)", async () => {
		const { server, collection, engine } = await setup();
		collection.upsert("mine", { n: 1 });
		server.beforeNextWrite(() =>
			server.put({ format: "lww-1", entries: { theirs: entry(2, 5) } }),
		);
		await engine.push();
		assert.deepEqual(Object.fromEntries(server.values()), {
			theirs: { n: 2 },
			mine: { n: 1 },
		});
		assert.deepEqual(values(collection), { theirs: 2, mine: 1 });
	});

	it("gives up with an error if the remote keeps changing, and retries later", async () => {
		const server = createFakeBlobServer<Item>({ cas: true });
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter: createBlobSyncAdapter(server),
			retry: { maxAttempts: 1 },
		});
		collection.upsert("a", { n: 1 });
		const keepChanging = (): void =>
			server.beforeNextWrite(() => {
				server.put({ format: "lww-1", entries: {} });
				keepChanging();
			});
		keepChanging();
		await assert.rejects(() => engine.push(), /kept conflicting/);
		server.beforeNextWrite(() => {});
		await engine.push();
		assert.deepEqual(Object.fromEntries(server.values()), { a: { n: 1 } });
	});

	it("dedupes concurrent push() calls, plus one more pass for calls made meanwhile", async () => {
		const adapter = createFakeSyncAdapter<Item>();
		const collection = await makeCollection();
		const engine = createSyncEngine({ collection, adapter });
		collection.upsert("a", { n: 1 });
		const first = engine.push();
		const second = engine.push();
		const third = engine.push();
		await wait(1);
		assert.equal(adapter.readCalls, 1);
		adapter.resolveRead({ entries: new Map() });
		await wait(1);
		adapter.resolveWrite();
		// The one queued pass finds nothing left to push, so it doesn't even read.
		await Promise.all([first, second, third]);
		assert.equal(adapter.readCalls, 1);
		assert.equal(adapter.writes.length, 1);
	});

	it("pushes entries imported from an old format, which the remote doesn't hold yet", async () => {
		const collection = await makeCollection();
		const writes: Array<Map<string, Entry<Item>>> = [];
		const adapter: SyncAdapter<Item> = {
			read: async () => ({
				entries: new Map(),
				imported: new Map([["old", entry(7, 3, "legacy")]]),
			}),
			write: async (entries) => {
				writes.push(new Map(entries));
			},
		};
		const engine = createSyncEngine({ collection, adapter });
		await engine.sync();
		assert.deepEqual(values(collection), { old: 7 });
		assert.deepEqual([...(writes[0]?.keys() ?? [])], ["old"]);
	});
});

describe("sync engine: sync()", () => {
	it("pushes when there are changes, else pulls; emits sync:success", async () => {
		const { server, collection, engine } = await setup();
		const events: string[] = [];
		engine.on("sync:start", ({ direction }) =>
			events.push(`start:${direction}`),
		);
		engine.on("sync:success", () => events.push("success"));
		await engine.sync();
		collection.upsert("a", { n: 1 });
		await engine.sync();
		assert.deepEqual(events, [
			"start:pull",
			"success",
			"start:push",
			"success",
		]);
		assert.equal(server.values().size, 1);
	});
});

describe("sync engine: retries, offline, and status", () => {
	it("retries a failing read via the injected sleep, then succeeds", async () => {
		let failures = 2;
		const collection = await makeCollection();
		const sleeps: number[] = [];
		const engine = createSyncEngine({
			collection,
			adapter: {
				read: async () => {
					if (failures-- > 0) throw new Error("flaky");
					return { entries: new Map([["a", entry(1, 5)]]) };
				},
			},
			retry: { maxAttempts: 5, jitter: false, baseDelayMs: 100 },
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		await engine.pull();
		assert.deepEqual(sleeps, [100, 200]);
		assert.deepEqual(values(collection), { a: 1 });
	});

	it("pull/push/sync no-op when offline, and reconnecting syncs when started", async () => {
		const network = createFakeNetworkStatus(false);
		const server = createFakeBlobServer<Item>();
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter: createBlobSyncAdapter(server),
			network,
		});
		collection.upsert("a", { n: 1 });
		await engine.pull();
		await engine.push();
		await engine.sync();
		assert.equal(server.writes, 0);
		assert.equal(engine.getState().online, false);
		engine.start({ syncOnStart: false });
		network.set(true);
		await wait();
		assert.equal(server.writes, 1);
		engine.dispose();
	});

	it("phase is 'error' after a failure (and stays so while retrying), then 'idle' after a success", async () => {
		let fail = true;
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter: {
				read: async () => {
					if (fail) throw new Error("down");
					return { entries: new Map() };
				},
			},
			retry: { maxAttempts: 1 },
		});
		await assert.rejects(() => engine.pull(), /down/);
		assert.equal(engine.getState().phase, "error");
		assert.match(engine.getState().lastError ?? "", /down/);
		const phases: string[] = [];
		engine.status.subscribe((s) => phases.push(s.phase));
		fail = false;
		await engine.pull();
		assert.equal(phases.includes("syncing"), false);
		assert.equal(engine.getState().phase, "idle");
		assert.equal(engine.getState().lastError, undefined);
	});

	it("a push failure is cleared once there's nothing left to push", async () => {
		let fail = true;
		const server = createFakeBlobServer<Item>();
		const blob = createBlobSyncAdapter(server);
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter: {
				read: () => blob.read(),
				write: async (entries, options) => {
					if (fail) throw new Error("write refused");
					return blob.write(entries, options);
				},
			},
			retry: { maxAttempts: 1 },
		});
		collection.upsert("a", { n: 1 });
		await assert.rejects(() => engine.push(), /write refused/);
		assert.equal(engine.getState().phase, "error");
		// Someone else saved the same entry (e.g. another tab): nothing is left to push.
		fail = false;
		await blob.write(collection.snapshot(), {});
		await engine.pull();
		await engine.push();
		assert.equal(engine.getState().phase, "idle");
	});

	it("counts pending changes, including ones loaded from storage", async () => {
		const storage = createMemoryAdapter();
		await storage.merge(
			"items",
			new Map([["a", { entry: entry(1, 5, "me") }]]),
		);
		const collection = await makeCollection(storage);
		const engine = createSyncEngine({
			collection,
			adapter: createBlobSyncAdapter(createFakeBlobServer<Item>()),
		});
		await wait(1);
		assert.equal(engine.getState().pending, 1);
		collection.upsert("b", { n: 2 });
		assert.equal(engine.getState().pending, 2);
		await engine.push();
		assert.equal(engine.getState().pending, 0);
		assert.ok(engine.getState().lastSyncedAt !== undefined);
	});

	it("a pull after a failed load retries the load instead of failing forever", async () => {
		const inner = createMemoryAdapter();
		let failures = 1;
		const collection = createCollection<Item>({
			name: "items",
			storage: {
				...inner,
				readAll: async (c) => {
					if (failures-- > 0) throw new Error("disk unavailable");
					return inner.readAll(c);
				},
			},
			onError: () => {},
		});
		await collection.ready.catch(() => {});
		const engine = createSyncEngine({
			collection,
			adapter: {
				read: async () => ({ entries: new Map([["a", entry(1, 5)]]) }),
			},
		});
		await engine.pull();
		assert.equal(collection.hydrated, true);
		assert.deepEqual(values(collection), { a: 1 });
	});
});

describe("sync engine: automatic pushes", () => {
	it("a burst of edits becomes one push after the debounce", async () => {
		const { server, collection, engine } = await setup();
		engine.start({ syncOnStart: false, pushOnChange: { debounceMs: 20 } });
		collection.upsert("a", { n: 1 });
		await wait(5);
		collection.upsert("b", { n: 2 });
		assert.equal(engine.getState().pushScheduled, true);
		await wait(5);
		assert.equal(server.writes, 0);
		await wait(40);
		assert.equal(server.writes, 1);
		assert.equal(engine.getState().pushScheduled, false);
		engine.dispose();
	});

	it("maxWaitMs bounds how long continuous edits can postpone a push", async () => {
		const { server, collection, engine } = await setup();
		engine.start({
			syncOnStart: false,
			pushOnChange: { debounceMs: 20, maxWaitMs: 40 },
		});
		for (let i = 0; i < 8; i++) {
			collection.upsert("a", { n: i });
			await wait(10);
		}
		assert.ok(server.writes >= 1);
		engine.dispose();
	});

	it("remote data never schedules a push; edits from other tabs do", async () => {
		const { collection, engine } = await setup();
		engine.start({ syncOnStart: false, pushOnChange: { debounceMs: 0 } });
		collection.mergeRemote(new Map([["a", entry(1, 5)]]), { synced: true });
		assert.equal(engine.getState().pushScheduled, false);
		collection.mergeFromTab(new Map([["b", { entry: entry(2, 6) }]]), []);
		assert.equal(engine.getState().pushScheduled, true);
		engine.dispose();
	});

	it("is off unless pushOnChange is set", async () => {
		const { server, collection, engine } = await setup();
		engine.start({ syncOnStart: false });
		collection.upsert("a", { n: 1 });
		await wait();
		assert.equal(server.writes, 0);
		engine.dispose();
	});

	it("flush() pushes a scheduled change immediately", async () => {
		const { server, collection, engine } = await setup();
		engine.start({ syncOnStart: false, pushOnChange: { debounceMs: 60_000 } });
		collection.upsert("a", { n: 1 });
		await engine.flush();
		assert.equal(server.writes, 1);
		engine.dispose();
	});

	it("background failures don't reject, but are reported via sync:error", async () => {
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter: {
				read: async () => {
					throw new Error("down");
				},
				write: async () => {},
			},
			retry: { maxAttempts: 1 },
		});
		const errors: unknown[] = [];
		engine.on("sync:error", ({ error }) => errors.push(error));
		engine.start({ syncOnStart: false, pushOnChange: { debounceMs: 0 } });
		collection.upsert("a", { n: 1 });
		await wait();
		assert.equal(errors.length, 1);
		engine.dispose();
	});
});

describe("sync engine: lifecycle", () => {
	it("start({ intervalMs }) syncs periodically until stop(); start() twice doesn't double it", async () => {
		let reads = 0;
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter: {
				read: async () => {
					reads++;
					return { entries: new Map() };
				},
			},
		});
		engine.start({ intervalMs: 10, syncOnStart: false });
		engine.start({ intervalMs: 10, syncOnStart: false });
		await wait(55);
		engine.stop();
		const counted = reads;
		assert.ok(counted >= 3 && counted <= 6, `${counted} reads`);
		await wait(30);
		assert.equal(reads, counted);
	});

	it("syncOnStart (default) syncs once right away", async () => {
		const { server, collection, engine } = await setup();
		collection.upsert("a", { n: 1 });
		engine.start();
		await wait();
		assert.equal(server.writes, 1);
		engine.dispose();
	});

	it("calling start() again keeps a push that was already scheduled", async () => {
		const { server, collection, engine } = await setup();
		engine.start({ syncOnStart: false, pushOnChange: { debounceMs: 20 } });
		collection.upsert("a", { n: 1 });
		engine.start({ syncOnStart: false, pushOnChange: { debounceMs: 20 } });
		await wait(50);
		assert.equal(server.writes, 1);
		engine.dispose();
	});

	it("dispose() makes pull/push/sync no-ops", async () => {
		const { server, collection, engine } = await setup();
		engine.dispose();
		collection.upsert("a", { n: 1 });
		await engine.pull();
		await engine.push();
		await engine.sync();
		assert.equal(server.writes, 0);
	});

	it("waits for loading before syncing, so stored local edits are pushed, not overwritten", async () => {
		const inner = createMemoryAdapter();
		await inner.merge("items", new Map([["a", { entry: entry(9, 50, "me") }]]));
		const gate = createDeferred<void>();
		const collection = createCollection<Item>({
			name: "items",
			storage: {
				...inner,
				async readAll(c) {
					await gate.promise;
					return inner.readAll(c);
				},
			},
		});
		const server = createFakeBlobServer<Item>();
		server.put({ format: "lww-1", entries: { a: entry(1, 10) } });
		const engine = createSyncEngine({
			collection,
			adapter: createBlobSyncAdapter(server),
		});
		const syncing = engine.sync();
		gate.resolve();
		await syncing;
		assert.deepEqual(server.values().get("a"), { n: 9 });
	});
});
