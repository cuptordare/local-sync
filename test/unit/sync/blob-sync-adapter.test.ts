import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecordEnvelope } from "../../../src/records/record-envelope.js";
import { createBlobSyncAdapter } from "../../../src/sync/adapters/blob-sync-adapter.js";
import type { Mutation } from "../../../src/sync/sync-adapter.js";
import { createFakeBlobServer } from "../support/fake-blob-server.js";

interface V {
	v: string;
}

function rec(
	id: string,
	v: string,
	meta: Partial<RecordEnvelope<V>["meta"]> = {},
): RecordEnvelope<V> {
	return {
		id,
		data: { v },
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

const mutation = (record: RecordEnvelope<V>, n = 1): Mutation<V> => ({
	mutationId: `m${n}`,
	collection: "c",
	recordId: record.id,
	record,
});

describe("createBlobSyncAdapter: pull", () => {
	it("treats a missing blob as empty, and accepts a bare array of records", async () => {
		assert.deepEqual(
			await createBlobSyncAdapter<V>({
				read: async () => null,
				write: async () => {},
			}).pull({}),
			{ records: [] },
		);
		const bare = createBlobSyncAdapter<V>({
			read: async () => [rec("a", "1")],
			write: async () => {},
		});
		assert.equal((await bare.pull({})).records.length, 1);
	});

	it("throws on an unexpected shape (e.g. an error body) instead of caching it as data", async () => {
		const adapter = createBlobSyncAdapter<V>({
			read: async () => ({ error: "missing scope" }) as never,
			write: async () => {},
		});
		await assert.rejects(() => adapter.pull({}), /unexpected shape/);
	});
});

describe("createBlobSyncAdapter: push", () => {
	it("replaces only the pushed records, keeping everyone else's, stored as clean remote data", async () => {
		const server = createFakeBlobServer<V>();
		server.put([rec("theirs", "x")]);
		const adapter = createBlobSyncAdapter<V>(server);
		const result = await adapter.push?.([
			mutation(
				rec("mine", "y", { dirty: true, source: "local", remoteVersion: 7 }),
			),
		]);
		assert.deepEqual(result?.acked, ["m1"]);
		const stored = server.records.find((r) => r.id === "mine");
		assert.deepEqual(stored?.meta, {
			version: 1,
			createdAt: 0,
			updatedAt: 0,
			deleted: false,
			dirty: false,
			source: "remote",
		});
		assert.ok(server.records.find((r) => r.id === "theirs"));
	});

	it("rejects an edit based on an outdated copy, returning the current one", async () => {
		const server = createFakeBlobServer<V>();
		server.put([rec("k", "theirs", { version: 3 })]);
		const adapter = createBlobSyncAdapter<V>(server);
		const result = await adapter.push?.([
			mutation(rec("k", "mine", { version: 3, remoteVersion: 2, dirty: true })),
		]);
		assert.deepEqual(result?.acked, []);
		assert.equal(result?.rejected?.[0]?.record?.data.v, "theirs");
		assert.equal(server.writes, 0); // nothing accepted -> nothing written
	});

	it("accepts an edit whose content already matches the remote, whatever its base", async () => {
		const server = createFakeBlobServer<V>();
		server.put([rec("k", "same", { version: 3 })]);
		const adapter = createBlobSyncAdapter<V>(server);
		const result = await adapter.push?.([
			mutation(rec("k", "same", { version: 2, remoteVersion: 1 })),
		]);
		assert.deepEqual(result?.acked, ["m1"]);
	});

	it("records without remoteVersion (written before it existed) are accepted only if ahead", async () => {
		const server = createFakeBlobServer<V>();
		server.put([
			rec("ahead", "old", { version: 2 }),
			rec("behind", "old", { version: 5 }),
		]);
		const adapter = createBlobSyncAdapter<V>(server);
		const result = await adapter.push?.([
			mutation(rec("ahead", "new", { version: 3 }), 1),
			mutation(rec("behind", "new", { version: 1 }), 2),
		]);
		assert.deepEqual(result?.acked, ["m1"]);
		assert.deepEqual(
			result?.rejected?.map((r) => r.mutationId),
			["m2"],
		);
	});

	it("with etags, a concurrent write is detected and retried on top of it (nothing is erased)", async () => {
		const server = createFakeBlobServer<V>({ cas: true });
		server.put([]);
		const adapter = createBlobSyncAdapter<V>(server);
		// Another client writes its own record between our read and our write.
		server.beforeNextWrite(() => server.put([rec("theirs", "x")]));
		const result = await adapter.push?.([mutation(rec("mine", "y"))]);
		assert.deepEqual(result?.acked, ["m1"]);
		assert.deepEqual(server.records.map((r) => r.id).sort(), [
			"mine",
			"theirs",
		]);
	});

	it("gives up with an error if the blob keeps changing", async () => {
		const server = createFakeBlobServer<V>({ cas: true });
		server.put([]);
		const adapter = createBlobSyncAdapter<V>({
			read: () => server.read(),
			write: async () => ({ conflict: true }),
			maxConflictRetries: 2,
		});
		await assert.rejects(
			() => adapter.push?.([mutation(rec("mine", "y"))]) ?? Promise.resolve(),
			/kept conflicting after 3 attempts/,
		);
	});
});

describe("createBlobSyncAdapter: versions never go backwards", () => {
	it("a re-sent older copy with the same content is acked without overwriting, and the newer copy returned", async () => {
		const server = createFakeBlobServer<V>();
		server.put([rec("k", "same", { version: 2 })]);
		const adapter = createBlobSyncAdapter(server);
		const stale = rec("k", "same", {
			version: 1,
			dirty: true,
			source: "local",
		});
		const result = await adapter.push?.([mutation(stale)]);
		assert.deepEqual(result?.acked, ["m1"]);
		assert.equal(server.records[0]?.meta.version, 2);
		assert.equal(server.writes, 0);
		assert.equal(result?.records?.[0]?.meta.version, 2);
	});
});
