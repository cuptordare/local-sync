import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/test/e2e/fixtures/harness.html");
	await page.waitForFunction(() => window.__lsReady === true);
});

test("reflects navigator.onLine for the initial state", async ({ page }) => {
	const initial = await page.evaluate(() =>
		window.__ls.createNetworkStatus().isOnline(),
	);
	expect(initial).toBe(true); // Playwright pages start online
});

test("reacts to real browser online/offline events via page.context().setOffline()", async ({
	page,
	context,
}) => {
	await page.evaluate(() => {
		const net = window.__ls.createNetworkStatus();
		window.__netEvents = [];
		net.subscribe((online) => window.__netEvents.push(online));
		window.__net = net;
	});

	await context.setOffline(true);
	await page.waitForFunction(() => window.__netEvents.length >= 1);

	await context.setOffline(false);
	await page.waitForFunction(() => window.__netEvents.length >= 2);

	const events = await page.evaluate(() => window.__netEvents);
	expect(events).toEqual([false, true]);

	const isOnlineNow = await page.evaluate(() => window.__net.isOnline());
	expect(isOnlineNow).toBe(true);
});

test("set() force-overrides the state and notifies subscribers", async ({
	page,
}) => {
	const events = await page.evaluate(() => {
		const net = window.__ls.createNetworkStatus();
		const seen: boolean[] = [];
		net.subscribe((online) => seen.push(online));
		net.set(false);
		net.set(false); // no-op, same value
		net.set(true);
		return seen;
	});
	expect(events).toEqual([false, true]);
});
