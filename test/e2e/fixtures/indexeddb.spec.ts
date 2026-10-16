import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/test/e2e/fixtures/harness.html");
	await page.waitForFunction(() => window.__lsReady === true);
});

const entry = (value: unknown, stamp: number, device = "d.t") => ({
	value,
	deleted: false,
	stamp,
	device,
});

test("persists entries across a real page reload", async ({ page }) => {
	const dbName = `persist-${test.info().testId}`;
	await page.evaluate(
		async ({ databaseName, stored }) => {
			const adapter = window.__ls.createIndexedDBAdapter({ databaseName });
			await adapter.merge("notes", new Map([["note-1", stored]]));
			await adapter.close();
		},
		{
			databaseName: dbName,
			stored: { entry: entry({ text: "survives reload" }, 5) },
		},
	);

	await page.reload();
	await page.waitForFunction(() => window.__lsReady === true);

	const entries = await page.evaluate(async (databaseName) => {
		const adapter = window.__ls.createIndexedDBAdapter({ databaseName });
		return [...(await adapter.readAll("notes"))];
	}, dbName);

	expect(entries).toEqual([
		["note-1", { entry: entry({ text: "survives reload" }, 5) }],
	]);
});

test("adapters share a database by name, and are isolated across names", async ({
	page,
}) => {
	const dbName = `share-${test.info().testId}`;
	const seen = await page.evaluate(
		async ({ databaseName, stored }) => {
			const a = window.__ls.createIndexedDBAdapter({ databaseName });
			await a.merge("notes", new Map([["shared", stored]]));
			const b = window.__ls.createIndexedDBAdapter({ databaseName });
			const other = window.__ls.createIndexedDBAdapter({
				databaseName: `${databaseName}-other`,
			});
			return {
				same: (await b.readAll("notes")).size,
				other: (await other.readAll("notes")).size,
			};
		},
		{ databaseName: dbName, stored: { entry: entry({ text: "from a" }, 1) } },
	);
	expect(seen).toEqual({ same: 1, other: 0 });
});

test("close() then a subsequent operation reopens the database", async ({
	page,
}) => {
	const dbName = `reopen-${test.info().testId}`;
	const size = await page.evaluate(
		async ({ databaseName, stored }) => {
			const adapter = window.__ls.createIndexedDBAdapter({ databaseName });
			await adapter.merge("notes", new Map([["x", stored]]));
			await adapter.close();
			// The adapter must transparently reopen the DB after close(), not stay dead.
			return (await adapter.readAll("notes")).size;
		},
		{ databaseName: dbName, stored: { entry: entry("a", 1) } },
	);
	expect(size).toBe(1);
});

test("regression: a failed open is retried, not cached forever", async ({
	page,
}) => {
	const dbName = `fail-retry-${test.info().testId}`;
	const opens = await page.evaluate(async (databaseName) => {
		// A database already at version 2: the adapter's version-1 open fails (VersionError).
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open(databaseName, 2);
			request.onsuccess = () => {
				request.result.close();
				resolve();
			};
			request.onerror = () => reject(request.error);
		});
		let openCalls = 0;
		const countingFactory = {
			open: (name: string, version?: number) => {
				openCalls += 1;
				return indexedDB.open(name, version);
			},
		} as IDBFactory;
		const stale = window.__ls.createIndexedDBAdapter({
			databaseName,
			indexedDB: countingFactory,
		});
		const attempt = () =>
			stale.readAll("notes").then(
				() => false,
				() => true,
			);
		const firstFailed = await attempt();
		const afterFirst = openCalls;
		const secondFailed = await attempt();
		return { firstFailed, secondFailed, afterFirst, afterSecond: openCalls };
	}, dbName);
	expect(opens).toEqual({
		firstFailed: true,
		secondFailed: true,
		afterFirst: 1,
		afterSecond: 2, // the second call retried instead of reusing a cached rejection
	});
});

test("merge is atomic: concurrent merges from two connections keep the newest entry", async ({
	page,
}) => {
	const dbName = `atomic-${test.info().testId}`;
	const final = await page.evaluate(async (databaseName) => {
		// Two connections, like two tabs of one app, writing stamps 1..40 in a shuffled order.
		const a = window.__ls.createIndexedDBAdapter({ databaseName });
		const b = window.__ls.createIndexedDBAdapter({ databaseName });
		const stamps = Array.from({ length: 40 }, (_, i) => i + 1).sort(
			() => Math.random() - 0.5,
		);
		await Promise.all(
			stamps.map((stamp, i) =>
				(i % 2 === 0 ? a : b).merge(
					"notes",
					new Map([
						[
							"k",
							{ entry: { value: stamp, deleted: false, stamp, device: "d.t" } },
						],
					]),
				),
			),
		);
		return (await a.readAll("notes")).get("k")?.entry.stamp;
	}, dbName);
	expect(final).toBe(40);
});

test("data an older library version stored is imported on load, and left in place", async ({
	page,
}) => {
	const dbName = `legacy-${test.info().testId}`;
	const result = await page.evaluate(async (databaseName) => {
		// Exactly what the old library (and an old app version) wrote: version 1, one
		// "records" store with a by_collection index, rows { key, collection, record }.
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open(databaseName, 1);
			request.onupgradeneeded = () => {
				const store = request.result.createObjectStore("records", {
					keyPath: "key",
				});
				store.createIndex("by_collection", "collection", { unique: false });
			};
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("records", "readwrite");
				const record = (id: string, data: unknown, deleted = false) => ({
					key: `todo\u0000${id}`,
					collection: "todo",
					record: {
						id,
						data,
						meta: {
							version: 4,
							createdAt: 1_700_000_000_000,
							updatedAt: 1_700_000_500_000,
							deleted,
							dirty: false,
							source: "remote",
						},
					},
				});
				tx.objectStore("records").put(
					record("todo:shared", { items: ["milk"] }),
				);
				tx.objectStore("records").put(record("todo:gone", { items: [] }, true));
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});

		const app = window.__ls.createLocalSyncApp({ name: databaseName });
		const todo = app.keyValue<{ items: string[] }>("todo");
		await app.ready();
		const imported = { shared: todo.get("todo:shared"), keys: todo.keys() };
		await app.close();

		const legacy = window.__ls.createIndexedDBAdapter({ databaseName });
		const rows = await legacy.readLegacy?.("todo");
		return { ...imported, legacyRows: rows?.length };
	}, dbName);
	expect(result).toEqual({
		shared: { items: ["milk"] },
		keys: ["todo:shared"],
		legacyRows: 2, // the old rows are untouched (a backup, and still readable by old tabs)
	});
});
