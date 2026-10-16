import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalSyncErrorEvent } from "../../../src/app/app-events.js";
import { createLocalSyncApp } from "../../../src/app/create-local-sync-app.js";
import { lastWriteWins } from "../../../src/records/record-merge.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createBlobSyncAdapter } from "../../../src/sync/adapters/blob-sync-adapter.js";
import { createFakeBlobServer } from "../support/fake-blob-server.js";
import { createFakeNetworkStatus } from "../support/fake-network-status.js";
import { createDeferred } from "../support/fake-sync-adapter.js";

interface Todo {
	items: string[];
}

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client app sharing `server` (fast, deterministic sync settings). */
function client(server: ReturnType<typeof createFakeBlobServer<Todo>>) {
	const app = createLocalSyncApp({
		network: createFakeNetworkStatus(true),
		onError: () => {},
	});
	const todos = app.keyValue<Todo>("todos", {
		remote: createBlobSyncAdapter(server),
		defaultValue: () => ({ items: [] }),
		pushDebounceMs: 0,
		retry: { maxAttempts: 1 },
	});
	return { app, todos };
}

describe("app.keyValue: local behavior", () => {
	it("returns a frozen default for missing keys without storing it", async () => {
		const app = createLocalSyncApp();
		const todos = app.keyValue<Todo>("todos", {
			defaultValue: () => ({ items: [] }),
		});
		await app.ready();
		const value = todos.get("shared");
		assert.deepEqual(value, { items: [] });
		assert.equal(Object.isFrozen(value), true);
		assert.equal(todos.has("shared"), false);
		assert.deepEqual(todos.keys(), []);
		assert.equal(todos.collection.pending().length, 0); // never pushed
	});

	it("set/update/delete by key, with update starting from the default", async () => {
		const app = createLocalSyncApp();
		const todos = app.keyValue<Todo>("todos", {
			defaultValue: () => ({ items: [] }),
		});
		await app.ready();
		todos.update("shared", (t) => ({ items: [...t.items, "milk"] }));
		assert.deepEqual(todos.get("shared"), { items: ["milk"] });
		todos.set("shared", { items: ["milk"] }); // unchanged -> no-op
		assert.equal(todos.collection.peek("shared")?.meta.version, 1);
		assert.deepEqual(todos.entries(), [["shared", { items: ["milk"] }]]);
		todos.delete("shared");
		assert.deepEqual(todos.get("shared"), { items: [] });
	});

	it("update() before stored values load throws instead of clobbering them with the default", () => {
		const gate = createDeferred<void>();
		const inner = createMemoryAdapter();
		const storage: StorageAdapter = {
			...inner,
			readAll: async (c) => {
				await gate.promise;
				return inner.readAll(c);
			},
		};
		const app = createLocalSyncApp({ storage });
		const todos = app.keyValue<Todo>("todos", {
			defaultValue: () => ({ items: [] }),
		});
		assert.throws(() => todos.update("shared", (t) => t), /await app.ready/);
		gate.resolve();
	});

	it("watch() fires immediately, then only when the value changes", async () => {
		const app = createLocalSyncApp();
		const todos = app.keyValue<Todo>("todos", {
			defaultValue: () => ({ items: [] }),
		});
		await app.ready();
		const seen: string[][] = [];
		todos.watch("shared", (t) => seen.push([...t.items]));
		todos.set("shared", { items: ["a"] });
		todos.collection.markSynced(["shared"]); // metadata-only change: not reported
		todos.set("shared", { items: ["a", "b"] });
		assert.deepEqual(seen, [[], ["a"], ["a", "b"]]);
	});

	it("returns the same store for the same name, and refuses a different remote or kind", () => {
		const app = createLocalSyncApp();
		const remote = createBlobSyncAdapter(createFakeBlobServer<Todo>());
		const a = app.keyValue<Todo>("todos", { remote, autoSync: false });
		assert.equal(app.keyValue<Todo>("todos"), a);
		assert.throws(
			() =>
				app.keyValue<Todo>("todos", {
					remote: createBlobSyncAdapter(createFakeBlobServer<Todo>()),
				}),
			/different remote/,
		);
		assert.throws(
			() => app.collection("todos"),
			/already registered as a keyValue/,
		);
	});
});

describe("app.keyValue: watchAll", () => {
	it("fires when a value changes or is removed, not on sync bookkeeping", async () => {
		const app = createLocalSyncApp();
		const todos = app.keyValue<Todo>("todos");
		await app.ready();
		todos.set("a", { items: ["x"] });
		const seen: Array<Array<[string, Todo]>> = [];
		todos.watchAll((values) => seen.push([...values]), { immediate: false });
		todos.collection.markSynced(["a"]); // metadata only
		todos.set("a", { items: ["x"] }); // unchanged value
		todos.set("b", { items: ["y"] });
		todos.delete("a");
		todos.collection.purgeDeleted(); // removing a tombstone changes no value
		assert.deepEqual(seen, [
			[
				["a", { items: ["x"] }],
				["b", { items: ["y"] }],
			],
			[["b", { items: ["y"] }]],
		]);
		await app.close();
	});
});

describe("app.keyValue: syncing between clients", () => {
	it("a value set on one client reaches another", async () => {
		const server = createFakeBlobServer<Todo>();
		const a = client(server);
		const b = client(server);
		await Promise.all([a.app.ready(), b.app.ready()]);
		a.todos.set("shared", { items: ["milk"] });
		await wait(); // debounced push
		await b.app.sync();
		assert.deepEqual(b.todos.get("shared"), { items: ["milk"] });
		await Promise.all([a.app.close(), b.app.close()]);
	});

	it("concurrent edits to the same key are detected, not silently lost", async () => {
		const server = createFakeBlobServer<Todo>();
		const a = client(server);
		const b = client(server);
		await Promise.all([a.app.ready(), b.app.ready()]);
		a.todos.set("shared", { items: ["base"] });
		await wait();
		await b.app.sync(); // both now have "base"
		const conflicts: string[] = [];
		b.app.on("conflict", (e) => conflicts.push(`${e.collection}/${e.id}`));

		b.app.engine("todos")?.stop(); // hold B's push back so A can win the race
		a.todos.set("shared", { items: ["base", "from A"] });
		b.todos.set("shared", { items: ["base", "from B"] });
		await wait();
		await b.app.sync();

		assert.deepEqual(conflicts, ["todos/shared"]);
		// Default serverWins: B now shows A's saved value instead of silently overwriting it.
		assert.deepEqual(b.todos.get("shared"), { items: ["base", "from A"] });
		assert.deepEqual(server.records[0]?.data, { items: ["base", "from A"] });
		await Promise.all([a.app.close(), b.app.close()]);
	});

	it("a key can be set again after its deletion has synced", async () => {
		const server = createFakeBlobServer<Todo>();
		const { app, todos } = client(server);
		await app.ready();
		const conflicts: string[] = [];
		app.on("conflict", (e) => conflicts.push(e.id));
		await wait(); // initial sync
		// Push-on-change only (no polling): nothing pulls between these edits.
		todos.set("k", { items: ["first"] });
		await wait();
		todos.delete("k");
		await wait();
		todos.set("k", { items: ["second"] });
		await wait();
		assert.deepEqual(conflicts, []);
		assert.deepEqual(todos.get("k"), { items: ["second"] });
		assert.deepEqual(server.records[0]?.data, { items: ["second"] });
		await app.close();
	});

	it("a synced deletion isn't rewritten to storage on every later sync", async () => {
		const server = createFakeBlobServer<Todo>();
		const inner = createMemoryAdapter();
		let writes = 0; // storage writes/removes touching the deleted key
		const storage: StorageAdapter = {
			...inner,
			async write(collection, record) {
				if (record.id === "k") writes++;
				await inner.write(collection, record);
			},
			async writeMany(collection, records) {
				if (records.some((r) => r.id === "k")) writes++;
				await inner.writeMany(collection, records);
			},
			async remove(collection, id) {
				if (id === "k") writes++;
				await inner.remove(collection, id);
			},
		};
		const app = createLocalSyncApp({
			storage,
			network: createFakeNetworkStatus(true),
			onError: () => {},
		});
		const todos = app.keyValue<Todo>("todos", {
			remote: createBlobSyncAdapter(server),
			pushDebounceMs: 0,
		});
		await app.ready();
		todos.set("k", { items: ["x"] });
		await app.sync();
		todos.delete("k");
		await app.sync();
		await app.sync();
		await todos.collection.whenPersisted();
		writes = 0;
		for (let i = 0; i < 3; i++) {
			todos.set("other", { items: [String(i)] }); // unrelated edits keep pushing
			await app.sync();
		}
		await todos.collection.whenPersisted();
		assert.equal(writes, 0);
		await app.close();
	});

	it("close() lets every local write land before closing storage", async () => {
		const inner = createMemoryAdapter();
		const events: string[] = [];
		const storage: StorageAdapter = {
			...inner,
			async write(collection, record) {
				await wait(20);
				await inner.write(collection, record);
				events.push("write");
			},
			async writeMany(collection, records) {
				await wait(20);
				await inner.writeMany(collection, records);
				events.push("write");
			},
			async close() {
				events.push("close");
			},
		};
		const app = createLocalSyncApp({ storage });
		const todos = app.keyValue<Todo>("todos");
		await app.ready();
		todos.set("k", { items: ["x"] });
		await app.close();
		assert.deepEqual(events, ["write", "close"]);
	});

	it("close() pushes changes that were still waiting on the debounce", async () => {
		const server = createFakeBlobServer<Todo>();
		const app = createLocalSyncApp({
			network: createFakeNetworkStatus(true),
		});
		const todos = app.keyValue<Todo>("todos", {
			remote: createBlobSyncAdapter(server),
			pushDebounceMs: 60_000,
		});
		await app.ready();
		await wait(); // initial sync
		todos.set("shared", { items: ["late"] });
		assert.equal(app.status.get().pushScheduled, true);
		await app.close();
		assert.deepEqual(server.records[0]?.data, { items: ["late"] });
	});
});

interface Issue {
	key: string;
	title: string;
}

describe("app.source", () => {
	function fakeApi(pages: Issue[][]) {
		const api = {
			pages,
			calls: 0,
			fail: false,
			async fetchPage({ cursor }: { cursor: number | undefined }) {
				api.calls++;
				if (api.fail) throw new Error("HTTP 500");
				const index = cursor ?? 0;
				return {
					items: api.pages[index] ?? [],
					nextCursor: index + 1 < api.pages.length ? index + 1 : undefined,
				};
			},
		};
		return api;
	}

	it("fetches every page, caches items, and removes ones that disappear at the source", async () => {
		const api = fakeApi([
			[
				{ key: "A-1", title: "one" },
				{ key: "A-2", title: "two" },
			],
			[{ key: "A-3", title: "three" }],
		]);
		const app = createLocalSyncApp({ network: createFakeNetworkStatus(true) });
		const issues = app.source<Issue, unknown, number>("issues", {
			fetchPage: (args) => api.fetchPage(args),
			getId: (i) => i.key,
		});
		await wait();
		assert.deepEqual(
			issues.all().map((i) => i.key),
			["A-1", "A-2", "A-3"],
		);

		api.pages = [[{ key: "A-1", title: "one" }], [{ key: "A-3", title: "3!" }]];
		await issues.refresh();
		assert.deepEqual(
			issues.all().map((i) => `${i.key}:${i.title}`),
			["A-1:one", "A-3:3!"],
		);
		await app.close();
	});

	it("unchanged items keep their version, so a refresh doesn't wake watchers", async () => {
		const api = fakeApi([[{ key: "A-1", title: "one" }]]);
		const app = createLocalSyncApp({ network: createFakeNetworkStatus(true) });
		const issues = app.source<Issue, unknown, number>("issues", {
			fetchPage: (args) => api.fetchPage(args),
			getId: (i) => i.key,
		});
		await wait();
		let notified = 0;
		issues.query().subscribe(() => notified++);
		await issues.refresh();
		assert.equal(notified, 0);
		assert.equal(issues.collection.peek("A-1")?.meta.version, 1);
		await app.close();
	});

	it("is read-only: local writes are refused", async () => {
		const app = createLocalSyncApp({ network: createFakeNetworkStatus(true) });
		const issues = app.source<Issue>("issues", {
			fetchPage: async () => ({ items: [] }),
			getId: (i) => i.key,
		});
		const collection = issues.collection as unknown as {
			insert(d: unknown): void;
		};
		assert.throws(() => collection.insert({}), /read-only source/);
		assert.throws(
			() => app.collection("issues"),
			/already registered as a source/,
		);
		await app.close();
	});

	it("a failed fetch keeps the cache, sets the error status, and reports an app error", async () => {
		const api = fakeApi([[{ key: "A-1", title: "one" }]]);
		const app = createLocalSyncApp({ network: createFakeNetworkStatus(true) });
		const errors: LocalSyncErrorEvent[] = [];
		app.on("error", (e) => errors.push(e));
		const issues = app.source<Issue, unknown, number>("issues", {
			fetchPage: (args) => api.fetchPage(args),
			getId: (i) => i.key,
			retry: { maxAttempts: 1 },
		});
		await wait();
		api.fail = true;
		await assert.rejects(() => issues.refresh(), /HTTP 500/);
		assert.equal(issues.all().length, 1);
		assert.equal(app.status.get().phase, "error");
		assert.match(app.status.get().lastError ?? "", /^issues: .*HTTP 500/);
		assert.equal(errors[0]?.source, "sync");
		assert.equal(errors[0]?.collection, "issues");
		await app.close();
	});

	it("setFilter() refetches and drops items outside the new filter; numeric ids are fine", async () => {
		const all = [
			{ key: "1", title: "a", project: "X" },
			{ key: "2", title: "b", project: "Y" },
		];
		const app = createLocalSyncApp({ network: createFakeNetworkStatus(true) });
		const issues = app.source<
			{ key: string; title: string; project: string },
			{ project: string }
		>("issues", {
			fetchPage: async ({ filter }) => ({
				items: all.filter((i) => i.project === filter?.project),
			}),
			getId: (i) => Number(i.key),
			filter: { project: "X" },
		});
		await wait();
		assert.deepEqual(
			issues.all().map((i) => i.key),
			["1"],
		);
		await issues.setFilter({ project: "Y" });
		assert.deepEqual(
			issues.all().map((i) => i.key),
			["2"],
		);
		assert.ok(issues.peek("2"));
		await app.close();
	});
});

describe("app-level sync, status, and options", () => {
	it("app.status aggregates pending changes across collections", async () => {
		const app = createLocalSyncApp({ network: createFakeNetworkStatus(false) });
		const a = app.keyValue<Todo>("a", {
			remote: createBlobSyncAdapter(createFakeBlobServer<Todo>()),
		});
		const b = app.keyValue<Todo>("b", {
			remote: createBlobSyncAdapter(createFakeBlobServer<Todo>()),
		});
		await app.ready();
		a.set("x", { items: [] });
		b.set("y", { items: [] });
		assert.equal(app.status.get().pending, 2);
		assert.equal(app.status.get().online, false);
		await app.close();
	});

	it("app.sync() rejects when a remote fails", async () => {
		const app = createLocalSyncApp({
			network: createFakeNetworkStatus(true),
			onError: () => {},
		});
		app.keyValue<Todo>("todos", {
			remote: {
				pull: async () => {
					throw new Error("down");
				},
			},
			autoSync: false,
			retry: { maxAttempts: 1 },
		});
		await assert.rejects(() => app.sync(), /down/);
		await app.close();
	});

	it("accepts a merge strategy instance as the app default", async () => {
		const app = createLocalSyncApp({ merge: lastWriteWins() });
		const todos = app.collection<Todo>("todos");
		await app.ready();
		todos.insert({ items: [] }, { id: "k" });
		todos.update("k", { items: ["local"] });
		todos.applyRemote([
			{
				id: "k",
				data: { items: ["remote"] },
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
		assert.deepEqual(todos.peek("k")?.data, { items: ["local"] }); // local v2 > remote v1
	});

	it("background storage errors are reported as app error events", async () => {
		const failing: StorageAdapter = {
			...createMemoryAdapter(),
			write: async () => {
				throw new Error("quota exceeded");
			},
		};
		const app = createLocalSyncApp({ storage: failing });
		const errors: LocalSyncErrorEvent[] = [];
		app.on("error", (e) => errors.push(e));
		const notes = app.collection<Todo>("notes");
		await app.ready();
		notes.insert({ items: [] });
		await wait();
		assert.equal(errors[0]?.source, "storage");
		assert.match(String(errors[0]?.error), /quota exceeded/);
	});
});

describe("recipes: review regressions", () => {
	it("keyValue delete() before stored values load throws a clear 'await ready' error", async () => {
		const gate = createDeferred<void>();
		const inner = createMemoryAdapter();
		const storage: StorageAdapter = {
			...inner,
			readAll: async (c) => {
				await gate.promise;
				return inner.readAll(c);
			},
		};
		const app = createLocalSyncApp({ storage });
		const todos = app.keyValue<Todo>("todos");
		assert.throws(() => todos.delete("shared"), /await app.ready/);
		gate.resolve();
		await app.ready();
		todos.delete("shared"); // fine once loaded
	});

	it("a source with a transforming validator keeps unchanged items' versions across refreshes", async () => {
		const app = createLocalSyncApp({ network: createFakeNetworkStatus(true) });
		const issues = app.source<Issue>("issues", {
			fetchPage: async () => ({ items: [{ key: "A-1", title: "  one  " }] }),
			getId: (i) => i.key,
			validator: (d) => {
				const issue = d as Issue;
				return { ok: true, value: { ...issue, title: issue.title.trim() } };
			},
		});
		await issues.refresh();
		await issues.refresh();
		await issues.refresh();
		const record = issues.collection.peek("A-1");
		assert.equal(record?.data.title, "one");
		assert.equal(record?.meta.version, 1);
		await app.close();
	});
});
