import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEnvelope } from "../../../src/records/record-envelope.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";

describe("createMemoryAdapter", () => {
	it("write/read round-trips a record", async () => {
		const adapter = createMemoryAdapter();
		const record = createEnvelope({ n: 1 }, { id: "a" });
		await adapter.write("notes", record);
		const read = await adapter.read("notes", "a");
		assert.deepEqual(read, record);
	});

	it("read() returns undefined for a missing record", async () => {
		const adapter = createMemoryAdapter();
		assert.equal(await adapter.read("notes", "missing"), undefined);
	});

	it("collections are isolated from each other", async () => {
		const adapter = createMemoryAdapter();
		await adapter.write("a", createEnvelope({ n: 1 }, { id: "x" }));
		await adapter.write("b", createEnvelope({ n: 2 }, { id: "x" }));
		assert.equal((await adapter.readAll("a")).length, 1);
		assert.equal((await adapter.readAll("b")).length, 1);
		assert.notDeepEqual(
			await adapter.read("a", "x"),
			await adapter.read("b", "x"),
		);
	});

	it("writeMany() writes all given records", async () => {
		const adapter = createMemoryAdapter();
		await adapter.writeMany("notes", [
			createEnvelope({ n: 1 }, { id: "a" }),
			createEnvelope({ n: 2 }, { id: "b" }),
		]);
		assert.equal((await adapter.readAll("notes")).length, 2);
	});

	it("remove() deletes a record", async () => {
		const adapter = createMemoryAdapter();
		await adapter.write("notes", createEnvelope({ n: 1 }, { id: "a" }));
		await adapter.remove("notes", "a");
		assert.equal(await adapter.read("notes", "a"), undefined);
	});

	it("clear() removes an entire collection", async () => {
		const adapter = createMemoryAdapter();
		await adapter.writeMany("notes", [
			createEnvelope({ n: 1 }, { id: "a" }),
			createEnvelope({ n: 2 }, { id: "b" }),
		]);
		await adapter.clear("notes");
		assert.deepEqual(await adapter.readAll("notes"), []);
	});

	it("uses structuredClone isolation -- mutating a returned record doesn't affect internal state", async () => {
		const adapter = createMemoryAdapter();
		await adapter.write("notes", createEnvelope({ n: 1 }, { id: "a" }));
		const read = (await adapter.read("notes", "a")) as { data: { n: number } };
		read.data.n = 999;
		const readAgain = (await adapter.read("notes", "a")) as {
			data: { n: number };
		};
		assert.equal(readAgain.data.n, 1);
	});

	it("close() resolves without throwing", async () => {
		const adapter = createMemoryAdapter();
		await assert.doesNotReject(() => adapter.close());
	});
});
