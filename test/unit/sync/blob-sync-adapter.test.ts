import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Entry } from "../../../src/crdt/lww-map.js";
import type { BlobSnapshot } from "../../../src/sync/adapters/blob-sync-adapter.js";
import { createBlobSyncAdapter } from "../../../src/sync/adapters/blob-sync-adapter.js";

interface V {
	v: string;
}

const entry = (v: string, stamp = 5): Entry<V> => ({
	value: { v },
	deleted: false,
	stamp,
	device: "d1.t1",
});

const reading = (raw: unknown, legacy?: unknown) =>
	createBlobSyncAdapter<V>({
		read: async () => raw as BlobSnapshot<V>,
		write: async () => {},
		...(legacy !== undefined ? { legacy: { read: async () => legacy } } : {}),
	});

describe("createBlobSyncAdapter: read", () => {
	it("treats a missing document as empty, keeping its etag", async () => {
		assert.deepEqual(await reading(null).read(), { entries: new Map() });
		assert.deepEqual(await reading({ etag: "0" }).read(), {
			entries: new Map(),
			etag: "0",
		});
	});

	it("parses entries and the etag", async () => {
		const state = await reading({
			format: "lww-1",
			entries: { a: entry("x") },
			etag: "7",
		}).read();
		assert.deepEqual(state, {
			entries: new Map([["a", entry("x")]]),
			etag: "7",
		});
	});

	it("throws on an unexpected shape (e.g. an error body) instead of treating it as data", async () => {
		await assert.rejects(() => reading("oops").read(), /unexpected shape/);
		await assert.rejects(
			() => reading({ format: "lww-1", entries: { a: { error: "x" } } }).read(),
			/malformed entry for "a"/,
		);
		await assert.rejects(
			() => reading({ format: "lww-1", entries: "nope" }).read(),
			/unexpected shape/,
		);
	});

	it("refuses a document in another format, rather than overwrite it", async () => {
		await assert.rejects(
			() => reading({ format: "lww-2", entries: {} }).read(),
			/format "lww-2"/,
		);
		// The old format: an old app version still reads (and writes) it.
		await assert.rejects(
			() => reading({ records: [{ id: "a", meta: {} }] }).read(),
			/old \{ records \} format/,
		);
	});

	it("reads an empty old-format document as empty (what the Apps Script returns for a missing row)", async () => {
		assert.deepEqual(await reading({ records: [], etag: "0" }).read(), {
			entries: new Map(),
			etag: "0",
		});
	});
});

describe("createBlobSyncAdapter: write", () => {
	it("writes the format marker and entries, passing ifMatch through", async () => {
		const writes: unknown[] = [];
		const adapter = createBlobSyncAdapter<V>({
			read: async () => null,
			write: async (blob, options) => {
				writes.push({ blob, options });
				return { conflict: true };
			},
		});
		const result = await adapter.write(new Map([["a", entry("x")]]), {
			ifMatch: "3",
		});
		assert.deepEqual(result, { conflict: true });
		assert.deepEqual(writes, [
			{
				blob: { format: "lww-1", entries: { a: entry("x") } },
				options: { ifMatch: "3" },
			},
		]);
		// The JSON form is just that.
		assert.equal(
			JSON.stringify((writes[0] as { blob: unknown }).blob),
			'{"format":"lww-1","entries":{"a":{"value":{"v":"x"},"deleted":false,"stamp":5,"device":"d1.t1"}}}',
		);
	});

	it("keeps keys that are special in JavaScript objects", async () => {
		let saved: unknown;
		const adapter = createBlobSyncAdapter<V>({
			read: async () => JSON.parse(JSON.stringify(saved)),
			write: async (blob) => {
				saved = blob;
			},
		});
		await adapter.write(new Map([["__proto__", entry("x")]]), {});
		const state = await adapter.read();
		assert.deepEqual([...state.entries.keys()], ["__proto__"]);
	});
});

describe("createBlobSyncAdapter: legacy import", () => {
	const legacyRecord = {
		id: "old",
		data: { v: "from v1" },
		meta: { version: 3, updatedAt: 1_700_000_000_000, deleted: false },
	};

	it("imports the old document while the new one is empty (as imported, not remote, entries)", async () => {
		const state = await reading(
			{ etag: "0" },
			{ records: [legacyRecord] },
		).read();
		assert.equal(state.entries.size, 0);
		assert.equal(state.etag, "0");
		assert.deepEqual(state.imported?.get("old")?.value, { v: "from v1" });
		assert.equal(state.imported?.get("old")?.device, "legacy");
	});

	it("ignores the old document once the new one has entries", async () => {
		const state = await reading(
			{ format: "lww-1", entries: { a: entry("x") } },
			{ records: [legacyRecord] },
		).read();
		assert.equal(state.imported, undefined);
	});

	it("accepts a missing old document, and refuses a malformed one", async () => {
		assert.equal((await reading(null, null).read()).imported, undefined);
		await assert.rejects(
			() => reading(null, { error: "boom" }).read(),
			/Legacy blob read returned an unexpected shape/,
		);
	});
});
