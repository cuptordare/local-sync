import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollection } from "../../../src/collections/create-collection.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";
import { createSyncEngine } from "../../../src/sync/create-sync-engine.js";
import type { SyncAdapter } from "../../../src/sync/sync-adapter.js";
import { createInstantSleep } from "../support/fake-clock.js";
import { createFakeNetworkStatus } from "../support/fake-network-status.js";
import { createFakeSyncAdapter } from "../support/fake-sync-adapter.js";

interface Note {
	n: number;
}

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCollection() {
	return createCollection<Note>({
		name: "notes",
		storage: createStorageEngine(createMemoryAdapter()),
	});
}

describe("create-sync-engine: pull", () => {
	it("applies pulled records into the collection", async () => {
		const collection = makeCollection();
		const adapter = createFakeSyncAdapter<Note>({ readOnly: true });
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const pullPromise = engine.pull();
		adapter.resolvePull({
			records: [
				{
					id: "remote-1",
					data: { n: 1 },
					meta: {
						version: 1,
						createdAt: 0,
						updatedAt: 0,
						deleted: false,
						dirty: false,
						source: "remote",
					},
				},
			],
		});
		await pullPromise;
		assert.equal(collection.peek("remote-1")?.data.n, 1);
	});

	it("keepPendingOnPull=true (default) preserves a locally-dirty record", async () => {
		const collection = makeCollection();
		const id = collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>({ readOnly: true });
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const pullPromise = engine.pull();
		adapter.resolvePull({
			records: [
				{
					id,
					data: { n: 999 },
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
		});
		await pullPromise;
		assert.equal(collection.peek(id)?.data.n, 1); // local edit preserved
	});

	it("setFilter resets the cursor for the next pull", async () => {
		const collection = makeCollection();
		const adapter = createFakeSyncAdapter<Note>({ readOnly: true });
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const p1 = engine.pull();
		adapter.resolvePull({ records: [], cursor: "cursor-1" });
		await p1;

		const p2 = engine.pull();
		adapter.resolvePull({ records: [] });
		await p2;
		assert.equal(adapter.pullArgsHistory[1]?.cursor, "cursor-1");

		engine.setFilter("new-filter");
		const p3 = engine.pull();
		adapter.resolvePull({ records: [] });
		await p3;
		assert.equal(adapter.pullArgsHistory[2]?.cursor, undefined);
		assert.equal(adapter.pullArgsHistory[2]?.filter, "new-filter");
	});
});

describe("create-sync-engine: push", () => {
	it("pushes pending records and marks them synced on ack", async () => {
		const collection = makeCollection();
		const id = collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const pushPromise = engine.push();
		const mutationId = adapter.pushMutationsHistory[0]?.[0]
			?.mutationId as string;
		adapter.resolvePush({ acked: [mutationId] });
		await pushPromise;

		assert.equal(collection.peek(id)?.meta.dirty, false);
		assert.equal(collection.pending().length, 0);
	});

	it("is a no-op when there is nothing pending", async () => {
		const collection = makeCollection();
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		await engine.push();
		assert.equal(adapter.pushCalls, 0);
	});

	it("is a no-op for a read-only (pull-only) adapter", async () => {
		const collection = makeCollection();
		collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>({ readOnly: true });
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		await engine.push();
		assert.equal(adapter.pushCalls, 0);
	});

	it("dedupes concurrent push() calls into a single adapter call", async () => {
		const collection = makeCollection();
		collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const p1 = engine.push();
		const p2 = engine.push(); // called while p1's adapter.push() is still pending
		assert.equal(adapter.pushCalls, 1);

		const mutationId = adapter.pushMutationsHistory[0]?.[0]
			?.mutationId as string;
		adapter.resolvePush({ acked: [mutationId] });
		await Promise.all([p1, p2]);
		assert.equal(adapter.pushCalls, 1); // no second push call, since nothing new became dirty
	});

	it("a call requested while running re-runs for records dirtied in the meantime", async () => {
		const collection = makeCollection();
		collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const p1 = engine.push();
		collection.insert({ n: 2 }); // new dirty record while the first push is in flight
		const p2 = engine.push();

		const firstMutationId = adapter.pushMutationsHistory[0]?.[0]
			?.mutationId as string;
		adapter.resolvePush({ acked: [firstMutationId] });
		await wait(20); // let the do-while loop notice the newly-dirty record and re-run

		assert.equal(adapter.pushCalls, 2);
		const secondMutationId = adapter.pushMutationsHistory[1]?.[0]
			?.mutationId as string;
		adapter.resolvePush({ acked: [secondMutationId] });
		await Promise.all([p1, p2]);
		assert.equal(collection.pending().length, 0);
	});

	it("protects against a stale push response after the record changed mid-flight (version-mismatch)", async () => {
		const collection = makeCollection();
		const id = collection.insert({ n: 1 }); // version 1, dirty
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const pushPromise = engine.push();
		const mutation = adapter.pushMutationsHistory[0]?.[0];
		assert.equal(mutation?.record.meta.version, 1);

		// The record is deleted locally WHILE the push is still in flight.
		collection.delete(id);
		assert.equal(collection.peek(id), undefined);
		const versionAfterDelete = collection.pending().find((r) => r.id === id)
			?.meta.version;
		assert.equal(versionAfterDelete, 2);

		// The (now-stale) server response arrives, acking the version-1 push and
		// returning an authoritative version-1 record.
		adapter.resolvePush({
			acked: [mutation?.mutationId as string],
			records: [
				{
					id,
					data: { n: 1 },
					meta: {
						version: 1,
						createdAt: 0,
						updatedAt: 0,
						deleted: false,
						dirty: false,
						source: "remote",
					},
				},
			],
		});
		await pushPromise;

		// The delete must NOT have been overwritten/resurrected, and must still be pending
		// (the stale ack must not have cleared its dirty flag).
		assert.equal(collection.peek(id), undefined);
		const stillPending = collection.pending().find((r) => r.id === id);
		assert.ok(stillPending, "the mid-flight delete must still be pending");
		assert.equal(stillPending?.meta.version, 2);
	});
});

describe("create-sync-engine: sync (push then pull)", () => {
	it("calls push then pull, and emits sync:success", async () => {
		const collection = makeCollection();
		collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const events: string[] = [];
		engine.on("sync:success", () => events.push("sync:success"));

		const syncPromise = engine.sync();
		const mutationId = adapter.pushMutationsHistory[0]?.[0]
			?.mutationId as string;
		adapter.resolvePush({ acked: [mutationId] });
		await wait(10);
		adapter.resolvePull({ records: [] });
		await syncPromise;

		assert.equal(adapter.pushCalls, 1);
		assert.equal(adapter.pullCalls, 1);
		assert.deepEqual(events, ["sync:success"]);
	});

	it("dedupes concurrent sync() calls into a single in-flight run, plus one more requested round", async () => {
		const collection = makeCollection();
		const adapter = createFakeSyncAdapter<Note>({ readOnly: true });
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const p1 = engine.sync();
		const p2 = engine.sync(); // arrives while p1 is in flight -> doesn't start a concurrent run...
		await wait(5); // ...but sync() (unlike push()) has no "nothing changed" guard, so it
		assert.equal(adapter.pullCalls, 1); // still hasn't started a second pull while the first is pending
		adapter.resolvePull({ records: [] });

		// ...schedules exactly one more full round after the first finishes, to cover
		// whatever p2 was asking for.
		await wait(5);
		assert.equal(adapter.pullCalls, 2);
		adapter.resolvePull({ records: [] });
		await Promise.all([p1, p2]);
	});
});

describe("create-sync-engine: retry/backoff", () => {
	it("retries a failing pull via the injected sleep, then succeeds", async () => {
		const collection = makeCollection();
		let attempts = 0;
		const sleepCalls: number[] = [];
		const adapter: SyncAdapter<Note> = {
			async pull() {
				attempts += 1;
				if (attempts < 3) throw new Error("flaky");
				return { records: [] };
			},
		};
		const engine = createSyncEngine({
			collection,
			adapter,
			retry: { maxAttempts: 5, jitter: false, baseDelayMs: 1 },
			sleep: async (ms) => {
				sleepCalls.push(ms);
			},
		});
		await engine.pull();
		assert.equal(attempts, 3);
		assert.equal(sleepCalls.length, 2);
	});
});

describe("create-sync-engine: offline gating", () => {
	it("pull/push/sync no-op immediately when offline", async () => {
		const collection = makeCollection();
		collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>();
		const network = createFakeNetworkStatus(false);
		const engine = createSyncEngine({
			collection,
			adapter,
			network,
			sleep: createInstantSleep(),
		});

		await engine.pull();
		await engine.push();
		await engine.sync();
		assert.equal(adapter.pullCalls, 0);
		assert.equal(adapter.pushCalls, 0);
	});

	it("reconnecting triggers an automatic sync when started", async () => {
		const collection = makeCollection();
		const adapter = createFakeSyncAdapter<Note>({ readOnly: true });
		const network = createFakeNetworkStatus(false);
		const engine = createSyncEngine({
			collection,
			adapter,
			network,
			sleep: createInstantSleep(),
		});

		engine.start({ syncOnStart: false });
		assert.equal(adapter.pullCalls, 0);
		network.set(true);
		await wait(10);
		assert.equal(adapter.pullCalls, 1);
		adapter.resolvePull({ records: [] });
	});
});

describe("create-sync-engine: pushOnChange", () => {
	it("schedules a push automatically when the collection changes", async () => {
		const collection = makeCollection();
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		engine.start({ pushOnChange: true, syncOnStart: false });
		collection.insert({ n: 1 });
		await wait(10);
		assert.equal(adapter.pushCalls, 1);
		adapter.resolvePush({
			acked: [adapter.pushMutationsHistory[0]?.[0]?.mutationId as string],
		});
	});

	it("does not push automatically when pushOnChange is not enabled", async () => {
		const collection = makeCollection();
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		engine.start({ syncOnStart: false });
		collection.insert({ n: 1 });
		await wait(10);
		assert.equal(adapter.pushCalls, 0);
	});
});

describe("create-sync-engine: error handling asymmetry", () => {
	it("a direct pull() call rejects and emits sync:error on failure", async () => {
		const collection = makeCollection();
		const adapter: SyncAdapter<Note> = {
			pull: async () => {
				throw new Error("boom");
			},
		};
		const engine = createSyncEngine({
			collection,
			adapter,
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		const errors: unknown[] = [];
		engine.on("sync:error", (e) => errors.push(e));
		await assert.rejects(() => engine.pull(), /boom/);
		assert.equal(errors.length, 1);
	});

	it("pushOnChange-triggered failures are swallowed (no unhandled rejection) but still emit sync:error", async () => {
		const collection = makeCollection();
		const adapter: SyncAdapter<Note> = {
			pull: async () => ({ records: [] }),
			push: async () => {
				throw new Error("push failed");
			},
		};
		const engine = createSyncEngine({
			collection,
			adapter,
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		const errors: unknown[] = [];
		engine.on("sync:error", (e) => errors.push(e));
		engine.start({ pushOnChange: true, syncOnStart: false });
		collection.insert({ n: 1 });
		await wait(20);
		assert.equal(errors.length, 1); // the failure happened, but nothing threw to the caller
	});
});

describe("create-sync-engine: start/stop/dispose lifecycle", () => {
	it("start({ intervalMs }) runs sync periodically until stop()", async () => {
		const collection = makeCollection();
		let pullCalls = 0;
		const adapter: SyncAdapter<Note> = {
			pull: async () => {
				pullCalls += 1;
				return { records: [] };
			},
		};
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		engine.start({ intervalMs: 15, syncOnStart: false });
		await wait(70);
		engine.stop();
		const countAtStop = pullCalls;
		assert.ok(
			countAtStop >= 2,
			`expected several interval syncs, got ${countAtStop}`,
		);
		await wait(40);
		assert.equal(pullCalls, countAtStop); // stopped -- no further calls
	});

	it("syncOnStart (default true) runs one sync immediately", async () => {
		const collection = makeCollection();
		const adapter = createFakeSyncAdapter<Note>({ readOnly: true });
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		engine.start(); // fires a fire-and-forget sync() -- give it a tick to reach pull()
		await wait(5);
		assert.equal(adapter.pullCalls, 1);
		adapter.resolvePull({ records: [] });
	});

	it("dispose() makes pull/push/sync no-op", async () => {
		const collection = makeCollection();
		collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		engine.dispose();
		await engine.pull();
		await engine.push();
		await engine.sync();
		assert.equal(adapter.pullCalls, 0);
		assert.equal(adapter.pushCalls, 0);
	});
});

describe("create-sync-engine: events", () => {
	it("emits sync:start, pull:success, and push:success with documented payload shapes", async () => {
		const collection = makeCollection();
		collection.insert({ n: 1 });
		const adapter = createFakeSyncAdapter<Note>();
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});

		const starts: string[] = [];
		let pullCount: number | undefined;
		let pushCount: number | undefined;
		engine.on("sync:start", ({ direction }) => starts.push(direction));
		engine.on("pull:success", ({ count }) => {
			pullCount = count;
		});
		engine.on("push:success", ({ count }) => {
			pushCount = count;
		});

		const pushPromise = engine.push();
		adapter.resolvePush({
			acked: [adapter.pushMutationsHistory[0]?.[0]?.mutationId as string],
		});
		await pushPromise;

		const pullPromise = engine.pull();
		adapter.resolvePull({
			records: [
				{
					id: "r1",
					data: { n: 1 },
					meta: {
						version: 1,
						createdAt: 0,
						updatedAt: 0,
						deleted: false,
						dirty: false,
						source: "remote",
					},
				},
			],
		});
		await pullPromise;

		assert.deepEqual(starts, ["push", "pull"]);
		assert.equal(pushCount, 1);
		assert.equal(pullCount, 1);
	});
});
