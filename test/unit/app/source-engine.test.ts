import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourcePage } from "../../../src/app/source.js";
import { createSourceEngine } from "../../../src/app/source.js";
import { createCollection } from "../../../src/collections/create-collection.js";
import { createMemoryAdapter } from "../../../src/storage/memory-adapter.js";
import { createInstantSleep } from "../support/fake-clock.js";
import { createDeferred } from "../support/fake-sync-adapter.js";

interface Item {
	id: string;
	n: number;
}

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup<Filter = unknown>(
	fetchPage: (args: {
		filter: Filter | undefined;
		cursor: number | undefined;
	}) => Promise<SourcePage<Item, number>>,
	filter?: Filter,
) {
	const collection = createCollection<Item>({
		name: "items",
		storage: createMemoryAdapter(),
	});
	await collection.ready;
	const engine = createSourceEngine<Item, Filter, number>("items", collection, {
		fetchPage,
		getId: (item) => item.id,
		...(filter !== undefined ? { filter } : {}),
		retry: { maxAttempts: 1 },
		sleep: createInstantSleep(),
	});
	const ids = () =>
		collection
			.query()
			.getCurrentResult()
			.map((r) => r.id);
	return { collection, engine, ids };
}

const item = (id: string, n = 1): Item => ({ id, n });

describe("source engine: paging and snapshots", () => {
	it("follows nextCursor through every page within one pull", async () => {
		const pages = [[item("a")], [item("b")], [item("c")]];
		const cursors: Array<number | undefined> = [];
		const { engine, ids } = await setup(async ({ cursor }) => {
			cursors.push(cursor);
			const index = cursor ?? 0;
			return {
				items: pages[index] ?? [],
				...(index + 1 < pages.length ? { nextCursor: index + 1 } : {}),
			};
		});
		await engine.pull();
		assert.deepEqual(cursors, [undefined, 1, 2]);
		assert.deepEqual(ids(), ["a", "b", "c"]);
	});

	it("fails (instead of looping forever) when the same cursor comes back", async () => {
		const { engine } = await setup(async () => ({
			items: [],
			nextCursor: 1,
		}));
		await assert.rejects(() => engine.pull(), /same nextCursor twice/);
	});

	it("removes items the snapshot no longer contains", async () => {
		let items = [item("a"), item("b")];
		const { engine, ids } = await setup(async () => ({ items }));
		await engine.pull();
		items = [item("b")];
		await engine.pull();
		assert.deepEqual(ids(), ["b"]);
	});

	it("changes nothing if a later page fails", async () => {
		let failSecondPage = false;
		const { engine, ids } = await setup(async ({ cursor }) => {
			if (cursor === undefined) return { items: [item("new")], nextCursor: 1 };
			if (failSecondPage) throw new Error("page 2 failed");
			return { items: [item("old")] };
		});
		await engine.pull();
		assert.deepEqual(ids(), ["new", "old"]);
		failSecondPage = true;
		await assert.rejects(() => engine.pull(), /page 2 failed/);
		assert.deepEqual(ids(), ["new", "old"]);
	});

	it("rejects a malformed page or id", async () => {
		const bad = await setup(
			async () => null as unknown as SourcePage<Item, number>,
		);
		await assert.rejects(() => bad.engine.pull(), /must return \{ items/);
		const badId = await setup(async () => ({ items: [{ id: "", n: 1 }] }));
		await assert.rejects(
			() => badId.engine.pull(),
			/non-empty string or number/,
		);
	});
});

describe("source engine: filters and overlapping pulls", () => {
	it("a filter change during a slow pull ends with the NEW filter's data", async () => {
		const calls: unknown[] = [];
		const { engine, ids } = await setup<string>(async ({ filter }) => {
			calls.push(filter);
			await wait(filter === "old" ? 40 : 5); // the old-filter pull is the slow one
			return { items: [item(`${filter}-1`)] };
		}, "old");
		const first = engine.pull();
		await wait(1); // the old filter's fetch is under way
		engine.setFilter("new");
		const second = engine.pull();
		await Promise.all([first, second]);
		assert.deepEqual(ids(), ["new-1"]);
		assert.deepEqual(calls, ["old", "new"]); // one at a time, newest filter last
	});

	it("pulls never overlap (e.g. a manual refresh during the interval refresh)", async () => {
		let running = 0;
		let maxRunning = 0;
		const { engine } = await setup(async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await wait(10);
			running--;
			return { items: [] };
		});
		await Promise.all([engine.pull(), engine.pull(), engine.pull()]);
		assert.equal(maxRunning, 1);
	});

	it("setFilter alone (no pull call) still re-runs a pull that was in flight", async () => {
		const { engine, ids } = await setup<string>(async ({ filter }) => {
			await wait(10);
			return { items: [item(`${filter}-1`)] };
		}, "old");
		const pulling = engine.pull();
		await wait(1);
		engine.setFilter("new"); // e.g. another tab changed the filter
		await pulling;
		assert.deepEqual(ids(), ["new-1"]);
	});

	it("a pull for the new filter still runs when the old filter's pull fails", async () => {
		const gate = createDeferred<void>();
		const calls: unknown[] = [];
		const { engine, collection } = await setup<string>(async ({ filter }) => {
			calls.push(filter);
			if (filter === "old") {
				await gate.promise;
				throw new Error("old filter failed");
			}
			return { items: [item("new-1")] };
		}, "old");
		const errors: unknown[] = [];
		engine.on("sync:error", ({ error }) => errors.push(error));
		const pulling = engine.pull();
		await wait(1); // the old filter's fetch is under way
		engine.setFilter("new");
		gate.resolve();
		await pulling; // the old filter's failure no longer matters
		assert.deepEqual(calls, ["old", "new"]);
		assert.ok(collection.peek("new-1"));
		assert.deepEqual(errors, []);
		assert.equal(engine.getState().phase, "idle");
	});

	it("a pull abandoned by a filter change isn't reported as a successful sync", async () => {
		const gate = createDeferred<void>();
		const { engine } = await setup<string>(async ({ filter }) => {
			if (filter === "old") await gate.promise;
			return { items: [] };
		}, "old");
		const successes: number[] = [];
		engine.on("pull:success", () => successes.push(1));
		const pulling = engine.pull();
		await wait(1);
		engine.setFilter("new");
		gate.resolve();
		await pulling;
		assert.equal(successes.length, 1); // only the new filter's pull
	});
});
