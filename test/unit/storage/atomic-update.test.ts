import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecordEnvelope } from "../../../src/records/record-envelope.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import type { StorageAdapter } from "../../../src/storage/storage-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";

const record = (id: string, text: string): RecordEnvelope<unknown> => ({
	id,
	data: { text },
	meta: {
		version: 1,
		createdAt: 0,
		updatedAt: 0,
		deleted: false,
		dirty: false,
		source: "local",
	},
});

describe("storage update (read, decide, write)", () => {
	it("passes the stored records in order and applies the writes and removals", async () => {
		const adapter = createMemoryAdapter();
		await adapter.writeMany("c", [record("a", "A"), record("b", "B")]);
		const engine = createStorageEngine(adapter);
		let seen: Array<string | undefined> = [];
		await engine.update("c", ["b", "missing", "a"], (stored) => {
			seen = stored.map((r) => (r?.data as { text: string } | undefined)?.text);
			return { write: [record("a", "A2")], remove: ["b"] };
		});
		assert.deepEqual(seen, ["B", undefined, "A"]);
		assert.deepEqual(
			(await adapter.readAll("c")).map((r) => [
				r.id,
				(r.data as { text: string }).text,
			]),
			[["a", "A2"]],
		);
	});

	it("falls back to read-then-write for adapters without update", async () => {
		const inner = createMemoryAdapter();
		await inner.write("c", record("a", "A"));
		const { update: _omitted, ...withoutUpdate } = inner;
		const engine = createStorageEngine(withoutUpdate as StorageAdapter);
		await engine.update("c", ["a"], ([stored]) => ({
			write: [{ ...(stored as RecordEnvelope<unknown>), data: { text: "A2" } }],
			remove: [],
		}));
		assert.deepEqual((await inner.read("c", "a"))?.data, { text: "A2" });
	});
});
