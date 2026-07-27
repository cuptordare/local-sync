import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSyncStatus } from "../../../src/sync/sync-status.js";

describe("createSyncStatus", () => {
	it("has sensible defaults", () => {
		const status = createSyncStatus();
		assert.deepEqual(status.get(), {
			phase: "idle",
			online: true,
			pending: 0,
			lastSyncedAt: undefined,
			lastSyncDurationMs: undefined,
			lastError: undefined,
		});
	});

	it("accepts initial overrides", () => {
		const status = createSyncStatus({ online: false, pending: 3 });
		assert.equal(status.get().online, false);
		assert.equal(status.get().pending, 3);
	});

	it("patch() merges a partial update", () => {
		const status = createSyncStatus();
		status.patch({ phase: "syncing" });
		assert.equal(status.get().phase, "syncing");
		assert.equal(status.get().online, true); // untouched fields survive
	});

	it("patch() with a deep-equal no-op does not notify subscribers", () => {
		const status = createSyncStatus();
		const seen: unknown[] = [];
		status.subscribe((s) => seen.push(s));
		status.patch({ phase: "idle" }); // already idle
		assert.deepEqual(seen, []);
		status.patch({ phase: "syncing" });
		assert.equal(seen.length, 1);
	});

	it("query() returns a working ReactiveQuery bound to the same state", () => {
		const status = createSyncStatus();
		const query = status.query();
		assert.equal(query.getCurrentResult().phase, "idle");
		const seen: string[] = [];
		query.subscribe((s) => seen.push(s.phase));
		status.patch({ phase: "error" });
		assert.deepEqual(seen, ["error"]);
	});
});
