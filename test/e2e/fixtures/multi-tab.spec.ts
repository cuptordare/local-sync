import { expect, test } from "@playwright/test";

// BroadcastChannel is scoped to same-origin, same-profile browsing contexts -- two pages in
// the SAME browser context are the closer analog to two real tabs of one browser than two
// separate contexts (which Playwright otherwise isolates like separate browser profiles).

test("leader election converges to the same leader across two real pages", async ({
	page,
	context,
}) => {
	const channelName = `mt-election-${test.info().testId}`;

	await page.goto("/test/e2e/fixtures/harness.html");
	await page.waitForFunction(() => window.__lsReady === true);
	await page.evaluate((name) => {
		window.__tab = window.__ls.createMultiTabSync({
			channelName: name,
			tabId: "page1",
		});
	}, channelName);

	const page2 = await context.newPage();
	await page2.goto("/test/e2e/fixtures/harness.html");
	await page2.waitForFunction(() => window.__lsReady === true);
	await page2.evaluate((name) => {
		window.__tab = window.__ls.createMultiTabSync({
			channelName: name,
			tabId: "page2",
		});
	}, channelName);

	// Give the real BroadcastChannel announce/heartbeat round-trip a moment to settle.
	await page.waitForFunction(
		() => window.__tab.isLeader() === true,
		undefined,
		{ timeout: 5000 },
	);
	await page2.waitForFunction(
		() => window.__tab.isLeader() === false,
		undefined,
		{ timeout: 5000 },
	);

	await page.evaluate(() => window.__tab.dispose());
	await page2.evaluate(() => window.__tab.dispose());
	await page2.close();
});

test("a real BroadcastChannel delivers app messages between two pages", async ({
	page,
	context,
}) => {
	const channelName = `mt-broadcast-${test.info().testId}`;

	await page.goto("/test/e2e/fixtures/harness.html");
	await page.waitForFunction(() => window.__lsReady === true);
	await page.evaluate((name) => {
		window.__tab = window.__ls.createMultiTabSync({
			channelName: name,
			tabId: "sender",
		});
	}, channelName);

	const page2 = await context.newPage();
	await page2.goto("/test/e2e/fixtures/harness.html");
	await page2.waitForFunction(() => window.__lsReady === true);
	await page2.evaluate((name) => {
		window.__received = [];
		window.__tab = window.__ls.createMultiTabSync({
			channelName: name,
			tabId: "receiver",
		});
		window.__tab.onBroadcast((message, fromTabId) =>
			window.__received.push({ message, fromTabId }),
		);
	}, channelName);

	await page.evaluate(() => window.__tab.broadcast({ type: "hello", n: 1 }));
	await page2.waitForFunction(() => window.__received.length >= 1);

	const received = await page2.evaluate(() => window.__received);
	expect(received).toEqual([
		{ message: { type: "hello", n: 1 }, fromTabId: "sender" },
	]);

	await page.evaluate(() => window.__tab.dispose());
	await page2.evaluate(() => window.__tab.dispose());
	await page2.close();
});

test("closing the leader page's tab hands leadership to the follower", async ({
	page,
	context,
}) => {
	const channelName = `mt-handoff-${test.info().testId}`;

	await page.goto("/test/e2e/fixtures/harness.html");
	await page.waitForFunction(() => window.__lsReady === true);
	await page.evaluate((name) => {
		window.__tab = window.__ls.createMultiTabSync({
			channelName: name,
			tabId: "leader",
		});
	}, channelName);

	const page2 = await context.newPage();
	await page2.goto("/test/e2e/fixtures/harness.html");
	await page2.waitForFunction(() => window.__lsReady === true);
	await page2.evaluate((name) => {
		window.__became = false;
		window.__tab = window.__ls.createMultiTabSync({
			channelName: name,
			tabId: "follower",
		});
		window.__tab.onLeadershipChange((isLeader) => {
			if (isLeader) window.__became = true;
		});
	}, channelName);

	await page.waitForFunction(
		() => window.__tab.isLeader() === true,
		undefined,
		{ timeout: 5000 },
	);
	await page2.waitForFunction(
		() => window.__tab.isLeader() === false,
		undefined,
		{ timeout: 5000 },
	);

	// A clean dispose() sends an immediate "bye", so the follower should take over promptly.
	await page.evaluate(() => window.__tab.dispose());
	await page2.waitForFunction(() => window.__became === true, undefined, {
		timeout: 5000,
	});
	await page2.waitForFunction(
		() => window.__tab.isLeader() === true,
		undefined,
		{ timeout: 5000 },
	);

	await page2.evaluate(() => window.__tab.dispose());
	await page2.close();
});
