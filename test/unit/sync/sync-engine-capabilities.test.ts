import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCollection } from "../../../src/collections/create-collection.js";
import type { RecordEnvelope } from "../../../src/records/record-envelope.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";
import { createSyncEngine } from "../../../src/sync/create-sync-engine.js";
import type {
	Mutation,
	PullArgs,
	PullResult,
	PushResult,
	SyncAdapter,
} from "../../../src/sync/sync-adapter.js";
import { createInstantSleep } from "../support/fake-clock.js";
import { createDeferred } from "../support/fake-sync-adapter.js";

interface Item {
	n: number;
}

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeCollection(storage?: StorageAdapter) {
	const collection = createCollection<Item>({
		name: "items",
		storage: createStorageEngine(storage ?? createMemoryAdapter()),
	});
	await collection.ready;
	return collection;
}

function rec(
	id: string,
	n: number,
	meta: Partial<RecordEnvelope<Item>["meta"]> = {},
): RecordEnvelope<Item> {
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
			...meta,
		},
	};
}

/** A pull-only adapter serving fixed pages keyed by cursor (undefined = first page). */
function pagedAdapter(
	pages: Record<string, PullResult<Item, string>>,
	calls: Array<PullArgs<unknown, string>> = [],
): SyncAdapter<Item, unknown, string> {
	return {
		async pull(args) {
			calls.push(args);
			const page = pages[args.cursor ?? "start"];
			if (page === undefined) throw new Error(`no page ${args.cursor}`);
			return page;
		},
	};
}

describe("sync engine: paginated pulls", () => {
	it("follows hasMore/cursor through every page within one pull()", async () => {
		const collection = await makeCollection();
		const calls: Array<PullArgs<unknown, string>> = [];
		const engine = createSyncEngine({
			collection,
			adapter: pagedAdapter(
				{
					start: { records: [rec("a", 1)], cursor: "p2", hasMore: true },
					p2: { records: [rec("b", 2)], cursor: "p3", hasMore: true },
					p3: { records: [rec("c", 3)] },
				},
				calls,
			),
			sleep: createInstantSleep(),
		});
		let count: number | undefined;
		engine.on("pull:success", (e) => {
			count = e.count;
		});
		await engine.pull();
		assert.deepEqual(
			calls.map((c) => c.cursor),
			[undefined, "p2", "p3"],
		);
		assert.deepEqual(
			collection
				.query()
				.getCurrentResult()
				.map((r) => r.id),
			["a", "b", "c"],
		);
		assert.equal(count, 3);
	});

	it("fails (instead of looping forever) when hasMore comes back without a new cursor", async () => {
		const collection = await makeCollection();
		const engine = createSyncEngine({
			collection,
			adapter: pagedAdapter({
				start: { records: [], cursor: "same", hasMore: true },
				same: { records: [], cursor: "same", hasMore: true },
			}),
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		await assert.rejects(() => engine.pull(), /endless loop/);
		assert.equal(engine.getState().phase, "error");
	});

	it("keeps a delta cursor between pulls (only the final page's cursor)", async () => {
		const collection = await makeCollection();
		const calls: Array<PullArgs<unknown, string>> = [];
		const engine = createSyncEngine({
			collection,
			adapter: pagedAdapter(
				{
					start: { records: [rec("a", 1)], cursor: "p2", hasMore: true },
					p2: { records: [], cursor: "since-42" },
					"since-42": { records: [], cursor: "since-42" },
				},
				calls,
			),
			sleep: createInstantSleep(),
		});
		await engine.pull();
		await engine.pull();
		assert.equal(calls.at(-1)?.cursor, "since-42");
	});
});

describe("sync engine: snapshot pulls", () => {
	it("removes clean local records the snapshot no longer contains, and keeps local edits", async () => {
		const collection = await makeCollection();
		collection.applyRemote([rec("stay", 1), rec("gone", 2), rec("edited", 3)]);
		collection.update("edited", { n: 33 });
		const engine = createSyncEngine({
			collection,
			adapter: pagedAdapter({
				start: { records: [rec("stay", 1)], cursor: "p2", hasMore: true },
				p2: { records: [rec("new", 4)], complete: true },
			}),
			sleep: createInstantSleep(),
		});
		await engine.pull();
		const ids = collection
			.query()
			.getCurrentResult()
			.map((r) => r.id)
			.sort();
		assert.deepEqual(ids, ["edited", "new", "stay"]);
	});

	it("removes nothing if a later page fails", async () => {
		const collection = await makeCollection();
		collection.applyRemote([rec("a", 1), rec("b", 2)]);
		const engine = createSyncEngine({
			collection,
			adapter: pagedAdapter({
				start: { records: [rec("a", 1)], cursor: "broken", hasMore: true },
			}),
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		await assert.rejects(() => engine.pull());
		assert.ok(collection.peek("b"), "b must survive a failed snapshot");
	});

	it("starts the next snapshot from the beginning (cursor reset)", async () => {
		const collection = await makeCollection();
		const calls: Array<PullArgs<unknown, string>> = [];
		const engine = createSyncEngine({
			collection,
			adapter: pagedAdapter(
				{
					start: { records: [], cursor: "p2", hasMore: true },
					p2: { records: [], cursor: "p3", complete: true },
				},
				calls,
			),
			sleep: createInstantSleep(),
		});
		await engine.pull();
		await engine.pull();
		assert.deepEqual(
			calls.map((c) => c.cursor),
			[undefined, "p2", undefined, "p2"],
		);
	});
});

/** A push adapter driven by a function, recording each batch. */
function scriptedPushAdapter(
	respond: (mutations: Mutation<Item>[], call: number) => PushResult<Item>,
) {
	const batches: Mutation<Item>[][] = [];
	const adapter: SyncAdapter<Item> = {
		async pull() {
			return { records: [] };
		},
		async push(mutations) {
			batches.push(mutations);
			return respond(mutations, batches.length);
		},
	};
	return { adapter, batches };
}

describe("sync engine: rejected pushes and conflicts", () => {
	it("a conflict (rejection with the server copy) is merged, reported, and re-pushed", async () => {
		const collection = await makeCollection();
		collection.applyRemote([rec("k", 1, { version: 1 })]);
		collection.update("k", { n: 2 }); // based on remote v1
		const { adapter, batches } = scriptedPushAdapter((mutations, call) => {
			const m = mutations[0] as Mutation<Item>;
			return call === 1
				? {
						acked: [],
						rejected: [
							{
								mutationId: m.mutationId,
								reason: "stale",
								record: rec("k", 9, { version: 3 }),
							},
						],
					}
				: { acked: [m.mutationId] };
		});
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		const conflicts: string[] = [];
		engine.on("conflict", (e) => conflicts.push(e.id));
		await engine.push();
		assert.deepEqual(conflicts, ["k"]);
		// Default merge is serverWins: the server copy is adopted and is clean, so nothing to re-push.
		assert.equal(collection.peek("k")?.data.n, 9);
		assert.equal(collection.peek("k")?.meta.remoteVersion, 3);
		assert.equal(batches.length, 1);
		assert.equal(collection.pending().length, 0);
	});

	it("a kept local edit after a conflict is pushed again within the same push()", async () => {
		const collection = createCollection<Item>({
			name: "items",
			storage: createStorageEngine(createMemoryAdapter()),
			merge: { merge: (local) => local }, // always keep the local edit
		});
		await collection.ready;
		collection.applyRemote([rec("k", 1, { version: 1 })]);
		collection.update("k", { n: 2 });
		const { adapter, batches } = scriptedPushAdapter((mutations, call) => {
			const m = mutations[0] as Mutation<Item>;
			return call === 1
				? {
						acked: [],
						rejected: [
							{
								mutationId: m.mutationId,
								reason: "stale",
								record: rec("k", 9, { version: 3 }),
							},
						],
					}
				: { acked: [m.mutationId] };
		});
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		await engine.push();
		assert.equal(batches.length, 2);
		const repushed = batches[1]?.[0]?.record;
		assert.equal(repushed?.data.n, 2);
		assert.equal(repushed?.meta.remoteVersion, 3); // now based on the server's version
		assert.ok((repushed?.meta.version ?? 0) > 3);
		assert.equal(collection.pending().length, 0);
	});

	it("an adapter that always rejects with a conflict can't cause an endless push loop", async () => {
		const collection = createCollection<Item>({
			name: "items",
			storage: createStorageEngine(createMemoryAdapter()),
			merge: { merge: (local) => local },
		});
		await collection.ready;
		collection.insert({ n: 1 }, { id: "k" });
		let serverVersion = 10;
		const { adapter, batches } = scriptedPushAdapter((mutations) => ({
			acked: [],
			rejected: mutations.map((m) => ({
				mutationId: m.mutationId,
				reason: "stale",
				record: rec("k", 0, { version: ++serverVersion }),
			})),
		}));
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		const rejectedEvents: string[] = [];
		engine.on("push:rejected", (e) => rejectedEvents.push(e.id));
		await engine.push();
		assert.ok(batches.length <= 4, `pushed ${batches.length} times`);
		assert.deepEqual(rejectedEvents, ["k"]);
		assert.equal(engine.getState().rejected, 1);
	});

	it("conflicts the server wins don't count against later, unrelated edits", async () => {
		const collection = await makeCollection(); // serverWins: each conflict ends clean
		collection.applyRemote([rec("k", 0, { version: 1 })]);
		const { adapter } = scriptedPushAdapter((mutations, call) => ({
			acked: [],
			rejected: mutations.map((m) => ({
				mutationId: m.mutationId,
				reason: "stale",
				record: rec("k", 0, { version: call * 10 }),
			})),
		}));
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		const conflicts: string[] = [];
		const rejected: string[] = [];
		engine.on("conflict", (e) => conflicts.push(e.id));
		engine.on("push:rejected", (e) => rejected.push(e.id));
		for (let edit = 1; edit <= 5; edit++) {
			collection.update("k", { n: edit });
			await engine.push();
			assert.equal(collection.pending().length, 0, `edit ${edit} settled`);
		}
		assert.equal(conflicts.length, 5);
		assert.deepEqual(rejected, []);
		assert.equal(engine.getState().rejected, 0);
	});

	it("a rejection without a server copy holds the record back until it is edited again", async () => {
		const collection = await makeCollection();
		collection.insert({ n: 1 }, { id: "k" });
		const { adapter, batches } = scriptedPushAdapter((mutations, call) =>
			call === 1
				? {
						acked: [],
						rejected: mutations.map((m) => ({
							mutationId: m.mutationId,
							reason: "forbidden",
						})),
					}
				: { acked: mutations.map((m) => m.mutationId) },
		);
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		await engine.push();
		await engine.push(); // held back: not re-sent
		assert.equal(batches.length, 1);
		assert.equal(engine.getState().rejected, 1);
		assert.equal(engine.getState().pending, 1);

		collection.update("k", { n: 2 }); // edited again -> eligible
		assert.equal(engine.getState().rejected, 0);
		await engine.push();
		assert.equal(batches.length, 2);
		assert.equal(collection.pending().length, 0);
	});
});

describe("sync engine: debounced pushOnChange", () => {
	it("coalesces a burst of edits into one push after the debounce", async () => {
		const collection = await makeCollection();
		const { adapter, batches } = scriptedPushAdapter((mutations) => ({
			acked: mutations.map((m) => m.mutationId),
		}));
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		engine.start({ pushOnChange: { debounceMs: 30 }, syncOnStart: false });
		collection.insert({ n: 1 });
		await wait(10);
		collection.insert({ n: 2 });
		await wait(10);
		collection.insert({ n: 3 });
		assert.equal(engine.getState().pushScheduled, true);
		assert.equal(batches.length, 0);
		await wait(60);
		assert.equal(batches.length, 1);
		assert.equal(batches[0]?.length, 3);
		assert.equal(engine.getState().pushScheduled, false);
		engine.dispose();
	});

	it("maxWaitMs bounds how long continuous edits can postpone a push", async () => {
		const collection = await makeCollection();
		const { adapter, batches } = scriptedPushAdapter((mutations) => ({
			acked: mutations.map((m) => m.mutationId),
		}));
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		engine.start({
			pushOnChange: { debounceMs: 40, maxWaitMs: 60 },
			syncOnStart: false,
		});
		for (let i = 0; i < 6; i++) {
			collection.insert({ n: i });
			await wait(20); // never quiet for 40ms
		}
		assert.ok(batches.length >= 1, "a push must happen within maxWaitMs");
		engine.dispose();
	});

	it("remote data and acks never schedule a push", async () => {
		const collection = await makeCollection();
		const { adapter, batches } = scriptedPushAdapter((mutations) => ({
			acked: mutations.map((m) => m.mutationId),
		}));
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		engine.start({ pushOnChange: { debounceMs: 5 }, syncOnStart: false });
		collection.applyRemote([rec("r", 1)]);
		assert.equal(engine.getState().pushScheduled, false);
		await wait(20);
		assert.equal(batches.length, 0);
		engine.dispose();
	});

	it("flush() pushes a scheduled change immediately", async () => {
		const collection = await makeCollection();
		const { adapter, batches } = scriptedPushAdapter((mutations) => ({
			acked: mutations.map((m) => m.mutationId),
		}));
		const engine = createSyncEngine({
			collection,
			adapter,
			sleep: createInstantSleep(),
		});
		engine.start({ pushOnChange: { debounceMs: 10_000 }, syncOnStart: false });
		collection.insert({ n: 1 });
		await engine.flush();
		assert.equal(batches.length, 1);
		assert.equal(engine.getState().pushScheduled, false);
		engine.dispose();
	});
});

describe("sync engine: status and defaults", () => {
	it("phase is 'error' after a failure and back to 'idle' after the next success", async () => {
		const collection = await makeCollection();
		let fail = true;
		const engine = createSyncEngine({
			collection,
			adapter: {
				async pull() {
					if (fail) throw new Error("down");
					return { records: [] };
				},
			},
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		await assert.rejects(() => engine.pull());
		assert.equal(engine.getState().phase, "error");
		assert.match(engine.getState().lastError ?? "", /down/);
		fail = false;
		await engine.pull();
		assert.equal(engine.getState().phase, "idle");
		assert.equal(engine.getState().lastError, undefined);
	});

	it("stays in 'error' while retrying, so a status badge doesn't just flash the failure", async () => {
		const collection = await makeCollection();
		const gate = createDeferred<void>();
		let calls = 0;
		const engine = createSyncEngine({
			collection,
			adapter: {
				async pull() {
					calls++;
					if (calls === 1) throw new Error("down");
					await gate.promise; // the retry is in flight...
					return { records: [] };
				},
			},
			retry: { maxAttempts: 1 },
			sleep: createInstantSleep(),
		});
		await assert.rejects(() => engine.pull());
		const retrying = engine.pull();
		assert.equal(engine.getState().phase, "error"); // ...and still reported as failing
		gate.resolve();
		await retrying;
		assert.equal(engine.getState().phase, "idle");
	});

	it("purgeDeletedOnPush removes acknowledged deletes (no unbounded tombstone growth)", async () => {
		const storage = createMemoryAdapter();
		const collection = await makeCollection(storage);
		const id = collection.insert({ n: 1 });
		collection.markSynced([id]);
		collection.delete(id);
		const { adapter } = scriptedPushAdapter((mutations) => ({
			acked: mutations.map((m) => m.mutationId),
		}));
		const engine = createSyncEngine({
			collection,
			adapter,
			purgeDeletedOnPush: true,
			sleep: createInstantSleep(),
		});
		await engine.push();
		await wait(); // let the background storage removal land
		assert.equal(collection.pending().length, 0);
		assert.equal(await storage.read("items", id), undefined);
	});

	it("calling start() twice does not double up interval syncs", async () => {
		const collection = await makeCollection();
		let pulls = 0;
		const engine = createSyncEngine({
			collection,
			adapter: {
				async pull() {
					pulls++;
					return { records: [] };
				},
			},
			sleep: createInstantSleep(),
		});
		engine.start({ intervalMs: 20, syncOnStart: false });
		engine.start({ intervalMs: 20, syncOnStart: false });
		await wait(70);
		engine.dispose();
		assert.ok(pulls <= 4, `expected ~3 interval pulls, got ${pulls}`);
	});

	it("waits for hydration before pulling, so stored local edits aren't clobbered", async () => {
		// Storage holds an un-pushed local edit; hydration is slow.
		const inner = createMemoryAdapter();
		await inner.write(
			"items",
			rec("k", 42, { version: 2, dirty: true, source: "local" }),
		);
		const gate = createDeferred<void>();
		const storage: StorageAdapter = {
			...inner,
			async readAll(name) {
				await gate.promise;
				return inner.readAll(name);
			},
		};
		const collection = createCollection<Item>({
			name: "items",
			storage: createStorageEngine(storage),
		});
		const engine = createSyncEngine({
			collection,
			adapter: { pull: async () => ({ records: [rec("k", 1)] }) },
			sleep: createInstantSleep(),
		});
		const pulling = engine.pull(); // starts before hydration completes
		gate.resolve();
		await pulling;
		assert.equal(collection.peek("k")?.data.n, 42);
		assert.equal(collection.peek("k")?.meta.dirty, true);
	});
});
