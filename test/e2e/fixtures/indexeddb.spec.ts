import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/test/e2e/fixtures/harness.html");
	await page.waitForFunction(() => window.__lsReady === true);
});

test("persists records across a real page reload", async ({ page }) => {
	const dbName = `persist-${test.info().testId}`;
	await page.evaluate(async (databaseName) => {
		const adapter = window.__ls.createIndexedDBAdapter({ databaseName });
		const record = window.__ls.createEnvelope(
			{ text: "survives reload" },
			{ id: "note-1" },
		);
		await adapter.write("notes", record);
		await adapter.close();
	}, dbName);

	await page.reload();
	await page.waitForFunction(() => window.__lsReady === true);

	const records = await page.evaluate(async (databaseName) => {
		const adapter = window.__ls.createIndexedDBAdapter({ databaseName });
		return adapter.readAll("notes");
	}, dbName);

	expect(records).toHaveLength(1);
	expect(records[0].data.text).toBe("survives reload");
});

test("two adapters with the same databaseName share (collide on) the same database", async ({
	page,
}) => {
	const dbName = `collide-${test.info().testId}`;
	const seenByB = await page.evaluate(async (databaseName) => {
		const a = window.__ls.createIndexedDBAdapter({ databaseName });
		await a.write(
			"notes",
			window.__ls.createEnvelope({ text: "from a" }, { id: "shared" }),
		);
		const b = window.__ls.createIndexedDBAdapter({ databaseName });
		return b.readAll("notes");
	}, dbName);
	expect(seenByB).toHaveLength(1);
	expect(seenByB[0].data.text).toBe("from a");
});

test("adapters with different databaseNames are isolated from each other", async ({
	page,
}) => {
	const dbA = `isolated-a-${test.info().testId}`;
	const dbB = `isolated-b-${test.info().testId}`;
	const seenByOther = await page.evaluate(
		async ({ dbA, dbB }) => {
			const a = window.__ls.createIndexedDBAdapter({ databaseName: dbA });
			await a.write(
				"notes",
				window.__ls.createEnvelope({ text: "only in a" }, { id: "x" }),
			);
			const other = window.__ls.createIndexedDBAdapter({ databaseName: dbB });
			return other.readAll("notes");
		},
		{ dbA, dbB },
	);
	expect(seenByOther).toHaveLength(0);
});

test("close() then a subsequent operation reopens the database", async ({
	page,
}) => {
	const dbName = `reopen-${test.info().testId}`;
	const result = await page.evaluate(async (databaseName) => {
		const adapter = window.__ls.createIndexedDBAdapter({ databaseName });
		await adapter.write(
			"notes",
			window.__ls.createEnvelope({ text: "a" }, { id: "x" }),
		);
		await adapter.close();
		// The adapter must transparently reopen the DB after close(), not stay dead.
		const read = await adapter.read("notes", "x");
		return read?.data.text;
	}, dbName);
	expect(result).toBe("a");
});

test("regression: a failed open is retried, not cached forever (dbPromise fix)", async ({
	page,
}) => {
	const dbName = `fail-retry-${test.info().testId}`;
	const opens = await page.evaluate(async (databaseName) => {
		// Create the DB at version 2 first, then close the connection.
		const v2 = window.__ls.createIndexedDBAdapter({ databaseName, version: 2 });
		await v2.write(
			"notes",
			window.__ls.createEnvelope({ text: "seed" }, { id: "x" }),
		);
		await v2.close();

		// Wrap indexedDB.open to count real open attempts.
		let openCalls = 0;
		const countingFactory = {
			open: (...args) => {
				openCalls += 1;
				return indexedDB.open(...args);
			},
		};

		// Requesting a LOWER version than what already exists always fails (VersionError).
		// With the bug, the first failure's rejected promise would be cached forever and
		// every subsequent call would replay it WITHOUT calling factory.open() again. With
		// the fix, each call retries -- so openCalls must increase on the second attempt.
		const stale = window.__ls.createIndexedDBAdapter({
			databaseName,
			version: 1,
			indexedDB: countingFactory,
		});

		let firstFailed = false;
		try {
			await stale.read("notes", "x");
		} catch {
			firstFailed = true;
		}
		const afterFirst = openCalls;

		let secondFailed = false;
		try {
			await stale.read("notes", "x");
		} catch {
			secondFailed = true;
		}
		const afterSecond = openCalls;

		return { firstFailed, secondFailed, afterFirst, afterSecond };
	}, dbName);

	expect(opens.firstFailed).toBe(true);
	expect(opens.secondFailed).toBe(true);
	expect(opens.afterFirst).toBe(1);
	expect(opens.afterSecond).toBe(2); // proves the second call retried instead of reusing a cached rejection
});
