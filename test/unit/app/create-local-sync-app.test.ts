import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalSyncApp } from "../../../src/app/create-local-sync-app.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createLocalSyncApp: collections", () => {
	it("collection(name) creates a new collection", () => {
		const app = createLocalSyncApp();
		const notes = app.collection<{ text: string }>("notes");
		assert.equal(notes.name, "notes");
		assert.equal(app.hasCollection("notes"), true);
		assert.deepEqual(app.collections, ["notes"]);
	});

	it("collection(name) is idempotent -- returns the SAME instance on a second call", () => {
		const app = createLocalSyncApp();
		const a = app.collection<{ text: string }>("notes");
		const b = app.collection<{ text: string }>("notes");
		assert.equal(a, b);
	});

	it("hasCollection() is false for an unregistered name", () => {
		const app = createLocalSyncApp();
		assert.equal(app.hasCollection("nope"), false);
	});

	it("emits collection:created on first registration only", () => {
		const app = createLocalSyncApp();
		const created: string[] = [];
		app.on("collection:created", ({ name }) => created.push(name));
		app.collection("notes");
		app.collection("notes"); // idempotent -- no second event
		assert.deepEqual(created, ["notes"]);
	});
});

describe("createLocalSyncApp: ready()", () => {
	it("resolves once all registered collections have hydrated", async () => {
		let resolveHydration!: () => void;
		const gate = new Promise<void>((resolve) => {
			resolveHydration = resolve;
		});
		const slowAdapter: StorageAdapter = {
			...createMemoryAdapter(),
			readAll: async () => {
				await gate;
				return new Map();
			},
		};
		const app = createLocalSyncApp({ storage: slowAdapter });
		app.collection("notes");

		let ready = false;
		const readyPromise = app.ready().then(() => {
			ready = true;
		});
		await wait(10);
		assert.equal(ready, false); // still hydrating

		resolveHydration();
		await readyPromise;
		assert.equal(ready, true);
	});

	it("retries a load that failed", async () => {
		const inner = createMemoryAdapter();
		let failures = 1;
		const app = createLocalSyncApp({
			storage: {
				...inner,
				readAll: async (collection) => {
					if (collection === "notes" && failures-- > 0)
						throw new Error("disk unavailable");
					return inner.readAll(collection);
				},
			},
			onError: () => {},
		});
		const notes = app.collection<{ text: string }>("notes");
		await assert.rejects(() => app.ready(), /disk unavailable/);
		await app.ready();
		assert.equal(notes.hydrated, true);
		notes.upsert("k", { text: "works" });
	});

	it("resolves immediately when there are no collections", async () => {
		const app = createLocalSyncApp();
		await assert.doesNotReject(() => app.ready());
	});
});

describe("createLocalSyncApp: close()", () => {
	it("disposes all collections, clears the registry, and emits 'disposed'", async () => {
		const app = createLocalSyncApp();
		const notes = app.collection<{ text: string }>("notes");
		let disposed = false;
		app.on("disposed", () => {
			disposed = true;
		});
		await app.close();
		assert.equal(disposed, true);
		assert.deepEqual(app.collections, []);
		assert.throws(() => notes.insert({ text: "x" }), /disposed/);
	});

	it("calling collection() after close() throws", async () => {
		const app = createLocalSyncApp();
		await app.close();
		assert.throws(() => app.collection("notes"), /closed/);
	});

	it("close() is idempotent", async () => {
		const app = createLocalSyncApp();
		await app.close();
		await assert.doesNotReject(() => app.close());
	});
});
