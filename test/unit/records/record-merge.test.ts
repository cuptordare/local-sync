import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createEnvelope,
	deleteEnvelope,
	updateEnvelope,
} from "../../../src/records/record-envelope.js";
import {
	custom,
	lastWriteWins,
	preferDeletion,
	serverWins,
} from "../../../src/records/record-merge.js";

describe("serverWins", () => {
	it("always returns the remote record, marked authoritative", () => {
		const local = createEnvelope({ n: 1 }, { now: 1000 });
		const remote = createEnvelope(
			{ n: 2 },
			{ now: 2000, source: "remote", dirty: false },
		);
		const result = serverWins<{ n: number }>().merge(local, remote);
		assert.equal(result.data.n, 2);
		assert.equal(result.meta.source, "remote");
		assert.equal(result.meta.dirty, false);
	});

	it("returns the same reference when remote is already clean+remote (no-op)", () => {
		const local = createEnvelope({ n: 1 });
		const remote = createEnvelope({ n: 2 }, { source: "remote", dirty: false });
		const result = serverWins<{ n: number }>().merge(local, remote);
		assert.equal(result, remote);
	});
});

describe("lastWriteWins", () => {
	it("remote wins when its version is higher", () => {
		const local = createEnvelope({ n: 1 }, { now: 5000 }); // version 1
		const remote = updateEnvelope(
			createEnvelope({ n: 0 }, { now: 1000 }),
			{ n: 2 },
			{ now: 1000, source: "remote" },
		); // version 2
		const result = lastWriteWins<{ n: number }>().merge(local, remote);
		assert.equal(result.data.n, 2);
	});

	it("local wins when its version is higher", () => {
		const remote = createEnvelope({ n: 1 }, { now: 1000, source: "remote" }); // version 1
		const local = updateEnvelope(createEnvelope({ n: 0 }), { n: 2 }); // version 2
		const result = lastWriteWins<{ n: number }>().merge(local, remote);
		assert.equal(result, local);
	});

	it("falls back to updatedAt when versions tie", () => {
		const local = createEnvelope({ n: 1 }, { now: 1000 });
		const remote = createEnvelope(
			{ n: 2 },
			{ now: 5000, source: "remote", dirty: false },
		);
		const result = lastWriteWins<{ n: number }>().merge(local, remote);
		assert.equal(result.data.n, 2); // remote's updatedAt is newer
	});

	it("ties on both version and updatedAt break toward remote", () => {
		const local = createEnvelope({ n: 1 }, { now: 1000 });
		const remote = createEnvelope(
			{ n: 2 },
			{ now: 1000, source: "remote", dirty: false },
		);
		const result = lastWriteWins<{ n: number }>().merge(local, remote);
		assert.equal(result.data.n, 2);
	});
});

describe("custom", () => {
	it("wraps an arbitrary merge function", () => {
		const strategy = custom<{ n: number }>((local, remote) => ({
			...remote,
			data: { n: local.data.n + remote.data.n },
		}));
		const local = createEnvelope({ n: 1 });
		const remote = createEnvelope({ n: 2 }, { source: "remote" });
		const result = strategy.merge(local, remote);
		assert.equal(result.data.n, 3);
	});
});

describe("preferDeletion", () => {
	// A merge strategy that only compares `data` and never looks at `meta.deleted` --
	// this is what real custom() merges typically look like, and exactly what can
	// silently resurrect a pending delete without this wrapper.
	const sameTextWins = custom<{ text: string }>((local, remote) =>
		local.data.text === remote.data.text
			? { ...remote, meta: { ...remote.meta, source: "remote", dirty: false } }
			: local,
	);

	it("a locally-deleted (dirty) record always wins over a non-deleted remote, even with identical data", () => {
		const original = createEnvelope({ text: "Buy milk" });
		const local = deleteEnvelope(original); // dirty tombstone, un-pushed
		const remote = createEnvelope(
			{ text: "Buy milk" }, // server hasn't seen the delete yet -- data still matches
			{ source: "remote", dirty: false },
		);
		const result = preferDeletion(sameTextWins).merge(local, remote);
		assert.equal(result, local); // the pending delete survives, not silently discarded
		assert.equal(result.meta.deleted, true);
		assert.equal(result.meta.dirty, true); // still pending -- the delete hasn't been pushed
	});

	it("a deleted remote wins over a non-deleted (dirty) local edit, discarding the edit", () => {
		const local = updateEnvelope(createEnvelope({ text: "old" }), {
			text: "local edit",
		});
		const remote = deleteEnvelope(
			createEnvelope({ text: "old" }, { source: "remote" }),
			{ source: "remote", dirty: false },
		);
		const result = preferDeletion(sameTextWins).merge(local, remote);
		assert.equal(result.meta.deleted, true);
		assert.equal(result.meta.dirty, false);
	});

	it("defers to the wrapped strategy when neither side is deleted", () => {
		const local = createEnvelope({ text: "a" });
		const remote = createEnvelope({ text: "b" }, { source: "remote" });
		const result = preferDeletion(sameTextWins).merge(local, remote);
		assert.equal(result, local); // sameTextWins' fallback when text differs
	});

	it("when both sides are deleted, resolves via the deleted remote (no real conflict left)", () => {
		const local = deleteEnvelope(createEnvelope({ text: "a" }));
		const remote = deleteEnvelope(
			createEnvelope({ text: "a" }, { source: "remote" }),
			{ source: "remote", dirty: false },
		);
		const result = preferDeletion(sameTextWins).merge(local, remote);
		assert.equal(result.meta.deleted, true);
		assert.equal(result.meta.dirty, false);
	});
});
