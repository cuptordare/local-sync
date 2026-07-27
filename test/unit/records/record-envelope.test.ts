import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createEnvelope,
	deleteEnvelope,
	isTombstone,
	markDirty,
	markSynced,
	patchEnvelope,
	updateEnvelope,
} from "../../../src/records/record-envelope.js";

describe("createEnvelope", () => {
	it("sets version 1 and dirty=true for a local record by default", () => {
		const e = createEnvelope({ text: "hi" });
		assert.equal(e.meta.version, 1);
		assert.equal(e.meta.dirty, true);
		assert.equal(e.meta.source, "local");
		assert.equal(e.meta.deleted, false);
		assert.equal(e.meta.createdAt, e.meta.updatedAt);
	});

	it("defaults dirty=false for a remote-sourced record", () => {
		const e = createEnvelope({ text: "hi" }, { source: "remote" });
		assert.equal(e.meta.dirty, false);
	});

	it("honors an explicit id, now, and dirty override", () => {
		const e = createEnvelope(
			{ text: "hi" },
			{ id: "fixed-id", now: 1000, dirty: false },
		);
		assert.equal(e.id, "fixed-id");
		assert.equal(e.meta.createdAt, 1000);
		assert.equal(e.meta.dirty, false);
	});

	it("generates a unique id when none is provided", () => {
		const a = createEnvelope({ text: "a" });
		const b = createEnvelope({ text: "b" });
		assert.notEqual(a.id, b.id);
	});
});

describe("updateEnvelope / patchEnvelope", () => {
	it("bumps version and updatedAt, and never mutates the input", () => {
		const original = createEnvelope({ text: "a" }, { now: 1000 });
		const updated = updateEnvelope(original, { text: "b" }, { now: 2000 });

		assert.notEqual(updated, original);
		assert.equal(updated.meta.version, 2);
		assert.equal(updated.meta.updatedAt, 2000);
		assert.equal(updated.meta.createdAt, original.meta.createdAt);
		assert.equal(original.data.text, "a"); // input untouched
		assert.equal(original.meta.version, 1);
	});

	it("clears the deleted flag (undeletes on update)", () => {
		const deleted = deleteEnvelope(createEnvelope({ text: "a" }));
		const revived = updateEnvelope(deleted, { text: "b" });
		assert.equal(revived.meta.deleted, false);
	});

	it("patchEnvelope shallow-merges into existing data", () => {
		const original = createEnvelope({ text: "a", done: false });
		const patched = patchEnvelope(original, { done: true });
		assert.deepEqual(patched.data, { text: "a", done: true });
		assert.equal(patched.meta.version, 2);
	});
});

describe("deleteEnvelope", () => {
	it("tombstones the record: deleted=true, version bumped, data retained", () => {
		const original = createEnvelope({ text: "a" });
		const deleted = deleteEnvelope(original);
		assert.equal(deleted.meta.deleted, true);
		assert.equal(deleted.meta.version, 2);
		assert.deepEqual(deleted.data, original.data);
	});
});

describe("markSynced / markDirty", () => {
	it("markSynced clears dirty", () => {
		const e = createEnvelope({ text: "a" });
		assert.equal(e.meta.dirty, true);
		const synced = markSynced(e);
		assert.equal(synced.meta.dirty, false);
	});

	it("markSynced returns the same reference if already clean", () => {
		const e = createEnvelope({ text: "a" }, { dirty: false });
		assert.equal(markSynced(e), e);
	});

	it("markDirty sets dirty and returns the same reference if already dirty", () => {
		const clean = createEnvelope({ text: "a" }, { dirty: false });
		const dirtied = markDirty(clean);
		assert.equal(dirtied.meta.dirty, true);
		assert.equal(markDirty(dirtied), dirtied);
	});
});

describe("isTombstone", () => {
	it("reflects meta.deleted", () => {
		const e = createEnvelope({ text: "a" });
		assert.equal(isTombstone(e), false);
		assert.equal(isTombstone(deleteEnvelope(e)), true);
	});
});
