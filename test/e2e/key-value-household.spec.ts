import { expect, type Page, test } from "@playwright/test";

const url = (device: string) =>
	`/examples/key-value-household/?device=${device}&latencyMs=50&syncMs=300`;

async function open(page: Page, device: string) {
	await page.goto(url(device));
	await expect(page.locator("#app")).toBeVisible();
}

async function addItem(page: Page, text: string) {
	await page.fill("#new-item", text);
	await page.click("#add-form button[type=submit]");
}

test.describe("key-value-household example", () => {
	test("an added item is saved, and survives a reload", async ({ page }) => {
		await open(page, "a");
		await addItem(page, "Milk");
		await expect(page.locator("#list li")).toHaveText(["Milk✕"]);
		await expect(page.locator("#status")).toHaveAttribute(
			"data-state",
			"saved",
		);
		await page.reload();
		await expect(page.locator("#list li")).toHaveText(["Milk✕"]);
	});

	test("changes made on one device show up on another", async ({ context }) => {
		const a = await context.newPage();
		const b = await context.newPage();
		await open(a, "a");
		await open(b, "b");
		await addItem(a, "Eggs");
		await expect(b.locator("#list li")).toHaveText(["Eggs✕"], {
			timeout: 5000,
		});
		await b.locator("#list li input[type=checkbox]").check();
		await expect(a.locator("#list li.done")).toHaveCount(1, { timeout: 5000 });
	});

	test("two tabs of the same device stay in step through shared storage", async ({
		context,
	}) => {
		const first = await context.newPage();
		const second = await context.newPage();
		await open(first, "same");
		await open(second, "same");
		// Offline, so the item can only reach the other tab locally (not via the server).
		await first.locator("details summary").click();
		await first.check("#offline");
		await second.locator("details summary").click();
		await second.check("#offline");
		await addItem(first, "Tea");
		await expect(second.locator("#list li")).toHaveText(["Tea✕"], {
			timeout: 2000,
		});
	});

	test("offline edits are kept and sync once back online", async ({
		context,
	}) => {
		const a = await context.newPage();
		const b = await context.newPage();
		await open(a, "a");
		await open(b, "b");
		await a.locator("details summary").click();
		await a.check("#offline");
		await addItem(a, "Bread");
		await expect(a.locator("#status")).toHaveAttribute("data-state", "offline");
		await expect(a.locator("#status-text")).toContainText("1 change(s)");
		await a.waitForTimeout(800);
		await expect(b.locator("#list li")).toHaveCount(0);
		await a.uncheck("#offline");
		await expect(a.locator("#status")).toHaveAttribute("data-state", "saved");
		await expect(b.locator("#list li")).toHaveText(["Bread✕"], {
			timeout: 5000,
		});
	});

	test("while idle: background checks run, but nothing is saved and it never says 'Saving…'", async ({
		page,
	}) => {
		await open(page, "a");
		await expect(page.locator("#status")).toHaveAttribute(
			"data-state",
			"saved",
		);
		// Record every status the badge shows while idle for a while (syncMs=300 here).
		const states = await page.evaluate(
			() =>
				new Promise<string[]>((resolve) => {
					const status = document.querySelector("#status") as HTMLElement;
					const seen: string[] = [];
					new MutationObserver(() => {
						seen.push(status.dataset.state ?? "");
					}).observe(status, { attributes: true });
					setTimeout(() => resolve(seen), 1500);
				}),
		);
		expect(states.filter((s) => s !== "saved")).toEqual([]);
		const activity = await page.locator("#activity li").allTextContents();
		expect(activity.some((line) => line.includes("read"))).toBe(true);
		expect(activity.some((line) => line.includes("write"))).toBe(false);

		// An edit is saved exactly once, shortly after.
		await addItem(page, "Butter");
		const writes = page.locator("#activity li", {
			hasText: 'write "shopping"',
		});
		await expect(writes).toHaveCount(1);
		await page.waitForTimeout(800); // background checks keep running...
		await expect(writes).toHaveCount(1); // ...but nothing is saved again
	});

	test("a server error is shown, keeps changes, and Retry recovers", async ({
		page,
	}) => {
		await open(page, "a");
		await page.locator("details summary").click();
		await page.check("#fail");
		await addItem(page, "Coffee");
		await expect(page.locator("#status")).toHaveAttribute(
			"data-state",
			"error",
			{
				timeout: 10_000,
			},
		);
		await expect(page.locator("#retry")).toBeVisible();
		await page.uncheck("#fail");
		await page.click("#retry");
		await expect(page.locator("#status")).toHaveAttribute(
			"data-state",
			"saved",
		);
	});
});
