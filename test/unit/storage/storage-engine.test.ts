import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEnvelope } from "../../../src/records/record-envelope.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import { createStorageEngine } from "../../../src/storage/storage-engine.js";

describe("createStorageEngine", () => {
	it("hydrate() builds an id-keyed Map from readAll()", async () => {
		const adapter = createMemoryAdapter();
		const engine = createStorageEngine(adapter);
		await engine.writeMany("notes", [
			createEnvelope({ n: 1 }, { id: "a" }),
			createEnvelope({ n: 2 }, { id: "b" }),
		]);
		const map = await engine.hydrate("notes");
		assert.equal(map.size, 2);
		const a = map.get("a");
		const b = map.get("b");
		assert.ok(a && b);
		assert.equal((a.data as { n: number }).n, 1);
		assert.equal((b.data as { n: number }).n, 2);
	});

	it("hydrate() on an empty collection returns an empty Map", async () => {
		const engine = createStorageEngine(createMemoryAdapter());
		const map = await engine.hydrate("nothing-here");
		assert.equal(map.size, 0);
	});

	it("proxies read/write/remove/clear/close through to the adapter", async () => {
		const engine = createStorageEngine(createMemoryAdapter());
		const record = createEnvelope({ n: 1 }, { id: "a" });
		await engine.write("notes", record);
		assert.deepEqual(await engine.read("notes", "a"), record);
		await engine.remove("notes", "a");
		assert.equal(await engine.read("notes", "a"), undefined);
		await engine.writeMany("notes", [record]);
		assert.equal((await engine.readAll("notes")).length, 1);
		await engine.clear("notes");
		assert.deepEqual(await engine.readAll("notes"), []);
		await assert.doesNotReject(() => engine.close());
	});
});
