import { expect, type Page, test } from "@playwright/test";

// The fake API seeds acme/web with 25 issues (#1-#25; 21 open) and acme/api with 8 (#26-#33; 6 open).
const URL = "/examples/read-only-issues/?latencyMs=30&refreshMs=600000";

async function open(page: Page) {
	await page.goto(URL);
	await expect(page.locator("#app")).toBeVisible();
	await expect(page.locator("#list li").first()).toBeVisible(); // first fetch done
	await expect(page.locator("#status")).toHaveAttribute("data-state", "ok");
}

test.describe("read-only-issues example", () => {
	test("follows every page of results (21 open issues over 3 pages of 10)", async ({
		page,
	}) => {
		await open(page);
		await expect(page.locator("#count")).toHaveText("Showing 21 of 21");
	});

	test("refresh reflects changes at the source, including removals", async ({
		page,
	}) => {
		await open(page);
		await page.evaluate(() => {
			const api = (
				window as unknown as {
					__api: Record<string, (...a: unknown[]) => void>;
				}
			).__api;
			api.close?.(1);
			api.remove?.(2);
			api.rename?.(3, "Renamed upstream");
		});
		await page.click("#refresh");
		await expect(page.locator("#count")).toHaveText("Showing 19 of 19");
		await expect(page.locator('#list li[data-number="1"]')).toHaveCount(0);
		await expect(page.locator('#list li[data-number="2"]')).toHaveCount(0);
		await expect(page.locator('#list li[data-number="3"] .title')).toHaveText(
			"Renamed upstream",
		);
	});

	test("changing the filter re-fetches and drops issues outside it", async ({
		page,
	}) => {
		await open(page);
		await page.selectOption("#repo", "acme/api");
		await expect(page.locator("#count")).toHaveText("Showing 6 of 6");
		await page.selectOption("#state", "all");
		await expect(page.locator("#count")).toHaveText("Showing 8 of 8");
	});

	test("searching filters locally", async ({ page }) => {
		await open(page);
		await page.fill("#search", "dark mode");
		await expect(page.locator("#list li")).not.toHaveCount(0);
		for (const title of await page.locator("#list .title").allTextContents()) {
			expect(title.toLowerCase()).toContain("dark mode");
		}
	});

	test("the saved copy is shown when the API fails, with an error status", async ({
		page,
	}) => {
		await open(page);
		// Reload with an API that always fails: the cached copy from IndexedDB is still shown.
		await page.addInitScript(() => {
			const original = window.Response.json;
			window.Response.json = (_body, init) =>
				original.call(
					window.Response,
					{ message: "down" },
					{ ...init, status: 503 },
				);
		});
		await page.reload();
		await expect(page.locator("#count")).toHaveText("Showing 21 of 21");
		await expect(page.locator("#status")).toHaveAttribute(
			"data-state",
			"error",
			{
				timeout: 10_000,
			},
		);
		await expect(page.locator("#status-text")).toContainText(
			"Showing the saved copy",
		);
	});
});
