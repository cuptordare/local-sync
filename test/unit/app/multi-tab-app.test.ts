import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalSyncApp } from "../../../src/app/create-local-sync-app.js";
import { createCollection } from "../../../src/collections/create-collection.js";
import { createInMemoryChannelHub } from "../../../src/network/tab-channel.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
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
				read: () => {
					pulls[label]++;
					return blob.read();
				},
				write: (entries, options) => blob.write(entries, options),
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
		assert.deepEqual(t.server.values().get("k"), {
			text: "edited in follower",
		});
		// The leader's save reaches the follower too: nothing is pending there.
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
		assert.deepEqual(t.server.values().get("k"), { text: "after handover" });
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
				read: async () => {
					pulls++;
					return { entries: new Map() };
				},
			},
		});
		await wait();
		assert.equal(pulls, 1); // started immediately, no leader election
		await app.close();
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
		assert.deepEqual(server.values().get("theme"), { text: "dark" });
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
				read: () => {
					pulls[who]++;
					return blob.read();
				},
				write: blob.write,
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

describe("multi-tab: merging between tabs", () => {
	it("edits made at the same moment in two tabs end the same in both tabs and in storage", async () => {
		const storage = createMemoryAdapter();
		const hub = createInMemoryChannelHub();
		const locks = createFakeLockManager();
		const tab = () => {
			const app = createLocalSyncApp({
				storage,
				network: createFakeNetworkStatus(true),
				multiTab: { channel: hub.connect(), locks },
			});
			return { app, items: app.keyValue<Item>("items") };
		};
		const a = tab();
		const b = tab();
		await Promise.all([a.app.ready(), b.app.ready()]);
		for (let i = 0; i < 5; i++) {
			a.items.set("k", { text: `a${i}` });
			b.items.set("k", { text: `b${i}` });
		}
		await wait();
		const stored = (await storage.readAll("items")).get("k")?.entry.value;
		assert.deepEqual(a.items.get("k"), b.items.get("k"));
		assert.deepEqual(stored, a.items.get("k"));
		await Promise.all([a.app.close(), b.app.close()]);
	});

	it("a late or repeated message from another tab can't roll a newer value back", async () => {
		const storage = createMemoryAdapter();
		const notes = createCollection<Item>({
			name: "items",
			storage,
			writerId: async () => "me",
		});
		await notes.ready;
		const old = {
			entry: {
				value: { text: "old" },
				deleted: false,
				stamp: 5,
				device: "tab2",
			},
		};
		notes.mergeFromTab(new Map([["k", old]]), []);
		notes.upsert("k", { text: "newer" });
		notes.mergeFromTab(new Map([["k", old]]), []); // arrives again, late
		assert.equal(notes.peek("k")?.data.text, "newer");
	});

	it("a write still landing when another tab loads is merged in, not lost", async () => {
		const inner = createMemoryAdapter();
		const gate = createDeferred<void>();
		let delayLoad = false;
		const storage: StorageAdapter = {
			...inner,
			async readAll(collection) {
				const result = await inner.readAll(collection);
				if (delayLoad && collection === "items") await gate.promise; // read before the write
				return result;
			},
		};
		const hub = createInMemoryChannelHub();
		const locks = createFakeLockManager();
		const tab = () => {
			const app = createLocalSyncApp({
				storage,
				network: createFakeNetworkStatus(true),
				multiTab: { channel: hub.connect(), locks },
			});
			return { app, items: app.keyValue<Item>("items") };
		};
		const a = tab();
		await a.app.ready();
		delayLoad = true;
		const b = tab(); // its load reads storage now...
		await wait(5);
		a.items.set("k", { text: "written meanwhile" }); // ...and this lands after that read
		await wait();
		gate.resolve();
		await b.app.ready();
		assert.deepEqual(b.items.get("k"), { text: "written meanwhile" });
		await Promise.all([a.app.close(), b.app.close()]);
	});
});
