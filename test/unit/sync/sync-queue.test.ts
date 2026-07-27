import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEnvelope } from "../../../src/records/record-envelope.js";
import { buildMutations } from "../../../src/sync/sync-queue.js";

describe("buildMutations", () => {
	it("maps dirty records into Mutations with the collection/recordId/record fields", () => {
		const record = createEnvelope({ n: 1 }, { id: "a" });
		const [mutation] = buildMutations("notes", [record]);
		assert.equal(mutation?.collection, "notes");
		assert.equal(mutation?.recordId, "a");
		assert.equal(mutation?.record, record);
		assert.equal(typeof mutation?.mutationId, "string");
	});

	it("gives every mutation a unique mutationId", () => {
		const records = [
			createEnvelope({ n: 1 }, { id: "a" }),
			createEnvelope({ n: 2 }, { id: "b" }),
		];
		const mutations = buildMutations("notes", records);
		assert.notEqual(mutations[0]?.mutationId, mutations[1]?.mutationId);
	});

	it("returns an empty array for no records", () => {
		assert.deepEqual(buildMutations("notes", []), []);
	});
});
