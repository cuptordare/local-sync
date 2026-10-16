import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalSyncApp } from "../../../src/app/create-local-sync-app.js";
import { createCollection } from "../../../src/collections/create-collection.js";
import { createInMemoryChannelHub } from "../../../src/network/multi-tab-sync.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";
import { createBlobSyncAdapter } from "../../../src/sync/adapters/blob-sync-adapter.js";
import { createFakeBlobServer } from "../support/fake-blob-server.js";
import { createFakeLockManager } from "../support/fake-lock-manager.js";
import { createFakeNetworkStatus } from "../support/fake-network-status.js";
import { createDeferred } from "../support/fake-sync-adapter.js";

interface Item {
	text: string;
}

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two "tabs" of one app: one shared storage (like IndexedDB), one shared channel and one shared
 * lock manager. Tab A requests the leader lock first, so it leads.
 */
function twoTabs(server = createFakeBlobServer<Item>()) {
	const storage = createMemoryAdapter();
	const hub = createInMemoryChannelHub();
	const locks = createFakeLockManager();
	let pulls = { a: 0, b: 0 };
	const tab = (label: "a" | "b") => {
		const app = createLocalSyncApp({
			storage,
			network: createFakeNetworkStatus(true),
			multiTab: { channel: hub.connect(), locks },
		});
		const blob = createBlobSyncAdapter<Item>(server);
		const items = app.keyValue<Item>("items", {
			remote: {
				pull: (args) => {
					pulls[label]++;
					return blob.pull(args);
				},
				push: (mutations) =>
					blob.push?.(mutations) ?? Promise.resolve({ acked: [] }),
			},
			pushDebounceMs: 0,
		});
		return { app, items };
	};
	const a = tab("a"); // requests the lock first: becomes the leader
	const b = tab("b");
	return {
		a,
		b,
		server,
		pulls: () => pulls,
		resetPulls: () => {
			pulls = { a: 0, b: 0 };
		},
	};
}

describe("multi-tab: apps sharing storage", () => {
	it("an edit in one tab shows up in the other", async () => {
		const { a, b } = twoTabs();
		await Promise.all([a.app.ready(), b.app.ready()]);
		const seen: Array<Item | undefined> = [];
		b.items.watch("k", (v) => seen.push(v), { immediate: false });
		a.items.set("k", { text: "from tab A" });
		await wait();
		assert.deepEqual(b.items.get("k"), { text: "from tab A" });
		assert.deepEqual(seen, [{ text: "from tab A" }]);
		await Promise.all([a.app.close(), b.app.close()]);
	});

	it("only the leader syncs automatically; it pushes edits made in other tabs", async () => {
		const t = twoTabs();
		await Promise.all([t.a.app.ready(), t.b.app.ready()]);
		await wait(); // initial sync
		assert.equal(t.pulls().b, 0, "the follower tab must not poll the remote");
		assert.ok(t.pulls().a >= 1);

		t.b.items.set("k", { text: "edited in follower" });
		await wait(50);
		assert.deepEqual(t.server.records[0]?.data, { text: "edited in follower" });
		// The leader's ack reaches the follower through storage too.
		assert.equal(t.b.items.collection.pending().length, 0);
		await Promise.all([t.a.app.close(), t.b.app.close()]);
	});

	it("follower tabs show the leader's sync status", async () => {
		const t = twoTabs();
		await Promise.all([t.a.app.ready(), t.b.app.ready()]);
		await wait(50);
		assert.notEqual(t.a.app.status.get().lastSyncedAt, undefined);
		assert.equal(
			t.b.app.status.get().lastSyncedAt,
			t.a.app.status.get().lastSyncedAt,
		);
		await Promise.all([t.a.app.close(), t.b.app.close()]);
	});

	it("when the leader tab closes, another takes over syncing", async () => {
		const t = twoTabs();
		await Promise.all([t.a.app.ready(), t.b.app.ready()]);
		await wait(); // initial sync
		t.resetPulls();
		await t.a.app.close(); // releases the lock: tab B gets it right away
		await wait(0);
		assert.ok(t.pulls().b >= 1, "the remaining tab should start syncing");
		t.b.items.set("k", { text: "after handover" });
		await wait(30);
		assert.deepEqual(t.server.records[0]?.data, { text: "after handover" });
		await t.b.app.close();
	});

	it("is off by default for custom storage (it may not be shared between tabs)", async () => {
		const app = createLocalSyncApp({
			storage: createMemoryAdapter(),
			network: createFakeNetworkStatus(true),
		});
		let pulls = 0;
		app.keyValue<Item>("items", {
			remote: {
				pull: async () => {
					pulls++;
					return { records: [] };
				},
			},
		});
		await wait();
		assert.equal(pulls, 1); // started immediately, no leader election
		await app.close();
	});
});

describe("collection.refreshFromStorage", () => {
	it("never reverts a local write that hasn't reached storage yet", async () => {
		const inner = createMemoryAdapter();
		const gate = createDeferred<void>();
		let holdWrites = false;
		const storage: StorageAdapter = {
			...inner,
			async write(collection, record) {
				if (holdWrites) await gate.promise;
				return inner.write(collection, record);
			},
		};
		const items = createCollection<Item>({
			name: "items",
			storage: createStorageEngine(storage),
		});
		await items.ready;
		await inner.write("items", {
			id: "k",
			data: { text: "from another tab" },
			meta: {
				version: 1,
				createdAt: 0,
				updatedAt: 0,
				deleted: false,
				dirty: false,
				source: "remote",
			},
		});
		holdWrites = true;
		items.upsert("k", { text: "local, not yet stored" });
		const refreshing = items.refreshFromStorage(["k"]); // queued behind the held write
		gate.resolve();
		await refreshing;
		assert.equal(items.peek("k")?.data.text, "local, not yet stored");
	});
});

describe("multi-tab: shared storage", () => {
	const tabCollection = (storage: StorageAdapter) =>
		createCollection<Item>({
			name: "items",
			storage: createStorageEngine(storage),
			sharedStorage: true,
		});

	it("marking a record synced never overwrites a newer edit another tab stored meanwhile", async () => {
		const storage = createMemoryAdapter();
		const a = tabCollection(storage);
		await a.ready;
		a.insert({ text: "v1" }, { id: "k" });
		await a.whenPersisted();
		const b = tabCollection(storage); // loads v1
		await b.ready;
		b.update("k", { text: "edited in B" });
		await b.whenPersisted();

		a.markSynced(["k"]); // A's push of v1 was acked, before A heard about B's edit
		await a.whenPersisted();

		const stored = await storage.read("items", "k");
		assert.equal((stored?.data as Item | undefined)?.text, "edited in B");
		assert.equal(stored?.meta.dirty, true, "B's edit still needs pushing");
		assert.equal(a.peek("k")?.data.text, "edited in B");
		assert.equal(a.pending().length, 1);
	});

	it("applying remote data never overwrites a newer edit another tab stored meanwhile", async () => {
		const storage = createMemoryAdapter();
		const a = tabCollection(storage);
		await a.ready;
		a.applyRemote([
			{
				id: "k",
				data: { text: "remote v1" },
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
		await a.whenPersisted();
		const b = tabCollection(storage);
		await b.ready;
		b.update("k", { text: "edited in B" });
		await b.whenPersisted();

		a.applyRemote([
			{
				id: "k",
				data: { text: "remote v2" },
				meta: {
					version: 2,
					createdAt: 0,
					updatedAt: 0,
					deleted: false,
					dirty: false,
					source: "remote",
				},
			},
		]);
		await a.whenPersisted();

		const stored = await storage.read("items", "k");
		assert.equal((stored?.data as Item | undefined)?.text, "edited in B");
		assert.equal(a.peek("k")?.data.text, "edited in B");
	});
});

describe("multi-tab: collections only some tabs use", () => {
	it("a follower syncs a collection the leader tab hasn't registered", async () => {
		const storage = createMemoryAdapter();
		const hub = createInMemoryChannelHub();
		const locks = createFakeLockManager();
		const server = createFakeBlobServer<Item>();
		const tab = () =>
			createLocalSyncApp({
				storage,
				network: createFakeNetworkStatus(true),
				multiTab: { channel: hub.connect(), locks },
			});
		const leader = tab(); // a page that never uses "prefs"
		const follower = tab();
		const prefs = follower.keyValue<Item>("prefs", {
			remote: createBlobSyncAdapter(server),
			pushDebounceMs: 0,
		});
		await follower.ready();
		await wait();
		prefs.set("theme", { text: "dark" });
		await wait(50);
		assert.deepEqual(server.records[0]?.data, { text: "dark" });
		assert.equal(prefs.collection.pending().length, 0);
		await Promise.all([leader.close(), follower.close()]);
	});

	it("a follower stops syncing a collection once the leader takes it over", async () => {
		const storage = createMemoryAdapter();
		const hub = createInMemoryChannelHub();
		const locks = createFakeLockManager();
		const server = createFakeBlobServer<Item>();
		const pulls = { leader: 0, follower: 0 };
		const tab = () =>
			createLocalSyncApp({
				storage,
				network: createFakeNetworkStatus(true),
				multiTab: { channel: hub.connect(), locks },
			});
		const remote = (who: keyof typeof pulls) => {
			const blob = createBlobSyncAdapter<Item>(server);
			return {
				pull: () => {
					pulls[who]++;
					return blob.pull({});
				},
				push: (mutations: Parameters<NonNullable<typeof blob.push>>[0]) =>
					blob.push?.(mutations) ?? Promise.resolve({ acked: [] }),
			};
		};
		const leader = tab();
		const follower = tab();
		follower.keyValue<Item>("prefs", {
			remote: remote("follower"),
			syncIntervalMs: 5,
		});
		await wait();
		assert.ok(
			pulls.follower >= 1,
			"the follower syncs it while the leader doesn't",
		);
		leader.keyValue<Item>("prefs", {
			remote: remote("leader"),
			syncIntervalMs: 5,
		});
		await wait();
		pulls.follower = 0;
		await wait(40);
		assert.equal(pulls.follower, 0, "only the leader polls it now");
		assert.ok(pulls.leader >= 1);
		await Promise.all([leader.close(), follower.close()]);
	});
});

describe("multi-tab: shared storage races", () => {
	const tabCollection = (storage: StorageAdapter) =>
		createCollection<Item>({
			name: "items",
			storage: createStorageEngine(storage),
			sharedStorage: true,
		});

	it("an ack doesn't make a newer edit another tab stored look like a conflict", async () => {
		const storage = createMemoryAdapter();
		const a = tabCollection(storage);
		await a.ready;
		a.insert({ text: "v1" }, { id: "k" });
		await a.whenPersisted();
		const pushed = a.pending()[0];
		assert.ok(pushed);
		const b = tabCollection(storage);
		await b.ready;
		b.update("k", { text: "edited in B" });
		await b.whenPersisted();

		a.acknowledge([pushed]); // A's push of v1 accepted, before A heard about B's edit
		await a.whenPersisted();

		const stored = await storage.read("items", "k");
		assert.equal((stored?.data as Item | undefined)?.text, "edited in B");
		assert.equal(stored?.meta.dirty, true, "B's edit still needs pushing");
		assert.equal(stored?.meta.remoteVersion, 1, "...based on the accepted v1");
	});

	it("an edit made from a copy another tab has since stored as accepted builds on that version", async () => {
		const storage = createMemoryAdapter();
		const a = tabCollection(storage);
		await a.ready;
		a.insert({ text: "v1" }, { id: "k" });
		await a.whenPersisted();
		const b = tabCollection(storage); // loads v1, not yet pushed
		await b.ready;
		a.acknowledge(a.pending()); // stored: v1, accepted
		await a.whenPersisted();

		b.update("k", { text: "edited in B" }); // before B heard about the ack
		await b.whenPersisted();

		const stored = await storage.read("items", "k");
		assert.equal((stored?.data as Item | undefined)?.text, "edited in B");
		assert.equal(stored?.meta.remoteVersion, 1);
		assert.equal(b.peek("k")?.meta.remoteVersion, 1);
	});

	it("a refresh requested before a local edit can't undo that edit", async () => {
		const storage = createMemoryAdapter();
		const a = tabCollection(storage);
		await a.ready;
		const b = tabCollection(storage);
		await b.ready;
		a.upsert("k", { text: "from A" });
		await a.whenPersisted();

		const refreshing = b.refreshFromStorage(["k"]); // A's announcement arrives...
		b.upsert("k", { text: "edited in B" }); // ...and B edits before the refresh runs
		await refreshing;
		await b.whenPersisted();

		assert.equal(b.peek("k")?.data.text, "edited in B");
		const stored = await storage.read("items", "k");
		assert.equal((stored?.data as Item | undefined)?.text, "edited in B");
	});
});

describe("multi-tab: acknowledgements and older copies", () => {
	it("an ack doesn't stamp an older copy (e.g. a tab that's behind) with the newer accepted version", async () => {
		const items = createCollection<Item>({
			name: "items",
			storage: createStorageEngine(createMemoryAdapter()),
		});
		await items.ready;
		items.insert({ text: "v1" }, { id: "k" });
		const older = items.peek("k");
		assert.ok(older);
		// Another tab pushed a later version (v2) of this record, and it was accepted.
		const sent = { ...older, meta: { ...older.meta, version: 2 } };
		items.acknowledge([sent]);
		const after = items.peek("k");
		assert.equal(after?.meta.version, 1);
		assert.equal(after?.meta.remoteVersion, undefined, "v1 isn't based on v2");
		assert.equal(after?.meta.dirty, true);
	});
});
