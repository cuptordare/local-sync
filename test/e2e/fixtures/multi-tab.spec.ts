import { expect, type Page, test } from "@playwright/test";

// BroadcastChannel and Web Locks are scoped to one origin and browser profile -- two pages in
// the SAME browser context are the closest analog to two real tabs of one browser.

async function openHarness(page: Page) {
	await page.goto("/test/e2e/fixtures/harness.html");
	await page.waitForFunction(() => window.__lsReady === true);
}

test("a real BroadcastChannel delivers messages between two pages", async ({
	page,
	context,
}) => {
	const channelName = `mt-broadcast-${test.info().testId}`;
	await openHarness(page);
	const page2 = await context.newPage();
	await openHarness(page2);
	await page2.evaluate((name) => {
		window.__received = [];
		window.__channel = window.__ls.createBroadcastChannelTab(name);
		window.__channel.subscribe((message) => window.__received.push(message));
	}, channelName);
	await page.evaluate((name) => {
		window.__channel = window.__ls.createBroadcastChannelTab(name);
		window.__channel.post({ type: "hello", entries: [["k", { n: 1 }]] });
	}, channelName);
	await page2.waitForFunction(() => window.__received.length >= 1);
	expect(await page2.evaluate(() => window.__received)).toEqual([
		{ type: "hello", entries: [["k", { n: 1 }]] },
	]);
	await page2.close();
});

/** An app on the shared database, with a remote that counts its reads. */
async function openApp(page: Page, name: string) {
	await openHarness(page);
	await page.evaluate((databaseName) => {
		window.__reads = 0;
		window.__app = window.__ls.createLocalSyncApp({ name: databaseName });
		window.__items = window.__app.keyValue<{ text: string }>("items", {
			remote: {
				read: async () => {
					window.__reads++;
					return { entries: new Map() };
				},
			},
			syncIntervalMs: 50,
		});
		return window.__app.ready();
	}, name);
}

test("tabs of one app share edits, and only the leader tab syncs", async ({
	page,
	context,
}) => {
	const name = `mt-app-${test.info().testId}`;
	await openApp(page, name);
	const page2 = await context.newPage();
	await openApp(page2, name);

	await page.evaluate(() => window.__items.set("k", { text: "from page 1" }));
	await page2.waitForFunction(
		() => window.__items.get("k")?.text === "from page 1",
	);

	await page.waitForFunction(() => window.__reads >= 2); // page 1 leads: it polls
	const followerReads = await page2.evaluate(() => window.__reads);
	expect(followerReads).toBe(0);

	// Closing the leader hands the Web Lock to page 2, which starts syncing right away.
	await page.evaluate(() => window.__app.close());
	await page2.waitForFunction(() => window.__reads >= 1, undefined, {
		timeout: 5000,
	});
	await page2.close();
});
