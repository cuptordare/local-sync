import { expect, type Page, test } from "@playwright/test";

// Smoke-drives examples/vanilla-js-notes-app itself -- the canonical, framework-free
// end-to-end reference for this library. Requires `dist/index.js` to exist (built via the
// `pretest:e2e` npm script) since the example imports it through a browser import map.
//
// The example renders two independent client panels (#client-a / #client-b) sharing one
// mock backend, so most tests exercise a single panel like a normal app, while the
// conflict/pending-edit tests deliberately drive both. `?latencyMs=` overrides the mock
// backend's simulated round-trip so runs here are fast and deterministic.
//
// Auto-sync (push on change + poll) is ON by default, matching normal app behavior -- most
// tests below rely on that and never touch the Push/Pull/Sync buttons at all. Tests that
// need to deliberately orchestrate a race (conflicts, the pending-edit protection, the
// error/retry demo) turn it off first via disableAutoSync(), the same knob a developer
// would use to instrument those edge cases.
async function disableAutoSync(page: Page, ...panels: string[]) {
	for (const panel of panels) {
		await page.uncheck(`${panel} .autosync-toggle`);
	}
}

test.describe("vanilla-js-notes-app example (smoke)", () => {
	test("optimistic insert renders immediately, tagged unsynced, then auto-clears once synced", async ({
		page,
	}) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=200");
		await expect(page.locator("#client-a .client-body")).toBeVisible();

		await page.fill("#client-a .note-input", "Buy milk");
		await page.click("#client-a .add-btn");

		const item = page.locator("#client-a .notes-list li", {
			hasText: "Buy milk",
		});
		await expect(item).toBeVisible(); // optimistic -- appears before any network call resolves
		await expect(item.locator(".unsynced")).toHaveCount(1);

		// No button click here -- auto-sync (pushOnChange) is on by default and should push
		// this within a tick, without any manual action.
		await expect(item.locator(".unsynced")).toHaveCount(0, { timeout: 5_000 });
	});

	test("the Sync button drives a manual full sync and updates status", async ({
		page,
	}) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=300");
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await page.click("#client-a .sync-btn");
		await expect(page.locator("#client-a .status-phase")).toContainText(
			"syncing",
		);
	});

	test("toggling network updates the status pill", async ({ page }) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=50");
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await expect(page.locator("#client-a .net")).toHaveText("online");
		await page.click("#client-a .online-toggle");
		await expect(page.locator("#client-a .net")).toHaveText("offline");
		await page.click("#client-a .online-toggle");
		await expect(page.locator("#client-a .net")).toHaveText("online");
	});

	test("pause/resume controls whether the list re-renders live, catching up on resume", async ({
		page,
	}) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=50");
		await expect(page.locator("#client-a .client-body")).toBeVisible();

		await page.click("#client-a .pause-btn");
		await expect(page.locator("#client-a .pause-btn")).toHaveText(
			"Resume live updates",
		);

		await page.fill("#client-a .note-input", "Added while paused");
		await page.click("#client-a .add-btn");
		// Subscription is torn down -- the DOM must NOT reflect the new note yet.
		await expect(page.locator("#client-a .notes-list li")).toHaveCount(0);

		await page.click("#client-a .pause-btn"); // resume
		await expect(page.locator("#client-a .pause-btn")).toHaveText(
			"Pause live updates",
		);
		// getCurrentResult() catch-up on resume must pick up what changed while paused.
		await expect(
			page.locator("#client-a .notes-list li", {
				hasText: "Added while paused",
			}),
		).toBeVisible();
	});

	test("deleting a note removes it from the list", async ({ page }) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=50");
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await page.fill("#client-a .note-input", "Temporary note");
		await page.click("#client-a .add-btn");
		const item = page.locator("#client-a .notes-list li", {
			hasText: "Temporary note",
		});
		await expect(item).toBeVisible();
		await item.locator(".delete-btn").click();
		await expect(item).toHaveCount(0);
	});

	test("a pending delete is not resurrected by a pull that hasn't seen it yet", async ({
		page,
	}) => {
		// Regression test: a delete is a dirty tombstone, so it goes through the same merge
		// path as any other edit. If a pull races ahead of the delete's own push -- easy to
		// hit with auto-sync's periodic polling, or here, explicitly, via keepPendingOnPull=false
		// -- a merge strategy that doesn't check `meta.deleted` can resurrect the "deleted" note,
		// only for it to vanish again on the next pull once the delete actually lands.
		// preferDeletion() (wired in client.js's resolveMerge) is what prevents this. (With the
		// default keepPendingOnPull=true, a dirty tombstone would never even reach merge --
		// this test forces the merge path specifically to prove preferDeletion works within it.)
		await page.goto(
			"/examples/vanilla-js-notes-app/?latencyMs=50&keepPendingOnPull=false",
		);
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await disableAutoSync(page, "#client-a");

		await page.fill("#client-a .note-input", "Buy milk");
		await page.click("#client-a .add-btn");
		await page.click("#client-a .push-btn"); // land it on the shared backend first
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);

		const item = page.locator("#client-a .notes-list li", {
			hasText: "Buy milk",
		});
		await item.locator(".delete-btn").click();
		await expect(item).toHaveCount(0); // removed immediately (optimistic)

		// Pull now, BEFORE the delete has been pushed -- the backend still has the old,
		// non-deleted record. A merge strategy that ignores tombstones would resurrect it
		// here. Wait for the pull to actually finish (not just for the click to dispatch) --
		// asserting toHaveCount(0) immediately would trivially pass since it's ALREADY 0 from
		// the optimistic delete above, without ever observing an async resurrection.
		await page.click("#client-a .pull-btn");
		await page.waitForTimeout(300); // 6x latencyMs -- safely past the pull's round-trip
		await expect(item).toHaveCount(0); // must still be gone, not flicker back
		// The delete must still be tracked as un-pushed -- a buggy merge would have marked
		// the resurrected record clean, silently losing the pending delete.
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"1 pending",
		);

		// Now let the delete actually sync, and confirm it stays gone afterward too.
		await page.click("#client-a .push-btn");
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);
		await page.click("#client-a .pull-btn");
		await expect(item).toHaveCount(0);
	});

	test("editing an existing note updates its text and auto-clears its unsynced tag", async ({
		page,
	}) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=200");
		await expect(page.locator("#client-a .client-body")).toBeVisible();

		await page.fill("#client-a .note-input", "Original text");
		await page.click("#client-a .add-btn");
		const item = page.locator("#client-a .notes-list li", {
			hasText: "Original text",
		});
		await item.locator(".edit-btn").click();
		await item.locator(".edit-textarea").fill("Edited text");
		await item.locator(".save-btn").click();

		const edited = page.locator("#client-a .notes-list li", {
			hasText: "Edited text",
		});
		await expect(edited).toBeVisible();
		await expect(edited.locator(".unsynced")).toHaveCount(1);

		// No button click here either -- auto-sync handles it.
		await expect(edited.locator(".unsynced")).toHaveCount(0, {
			timeout: 5_000,
		});
	});

	test("inserting text over the length limit shows a validation error instead of crashing", async ({
		page,
	}) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=50");
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await page.fill("#client-a .note-input", "x".repeat(501));
		await page.click("#client-a .add-btn");
		await expect(page.locator("#client-a .top-level-error")).toBeVisible();
		await expect(page.locator("#client-a .notes-list li")).toHaveCount(0);
	});

	test("notes persist in IndexedDB across a reload, isolated per client", async ({
		page,
	}) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=50");
		await expect(page.locator("#client-a .client-body")).toBeVisible();

		await page.fill("#client-a .note-input", "Survives reload");
		await page.click("#client-a .add-btn");
		await expect(
			page.locator("#client-a .notes-list li", { hasText: "Survives reload" }),
		).toBeVisible();

		await page.reload();
		await expect(page.locator("#client-a .client-body")).toBeVisible();

		await expect(
			page.locator("#client-a .notes-list li", { hasText: "Survives reload" }),
		).toBeVisible();
		// Client B uses a distinct IndexedDB databaseName and never pushed/pulled this note
		// through the (also freshly reset, in-memory) mock backend -- it must not appear there.
		await expect(
			page.locator("#client-b .notes-list li", { hasText: "Survives reload" }),
		).toHaveCount(0);
	});

	test("a simulated server failure surfaces an error banner with a working retry", async ({
		page,
	}) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=50");
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await disableAutoSync(page, "#client-a");

		await page.check("#server-error-toggle");

		await page.fill("#client-a .note-input", "Will fail to sync");
		await page.click("#client-a .add-btn");
		await page.click("#client-a .push-btn");

		await expect(page.locator("#client-a .error-banner")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator("#client-a .error-message")).toContainText(
			"simulated failure",
		);

		// Once the server recovers, Retry succeeds and the banner clears. (Toggling the
		// simulated failure off BEFORE retrying, rather than racing a retry against the
		// toggle, keeps this deterministic -- the engine de-dupes overlapping sync() calls
		// by awaiting the in-flight one rather than starting a second independent attempt.)
		await page.uncheck("#server-error-toggle");
		await page.click("#client-a .retry-btn");
		await expect(page.locator("#client-a .error-banner")).toBeHidden({
			timeout: 5_000,
		});
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);
	});

	test("editing a note protects the draft from a concurrent remote update", async ({
		page,
	}) => {
		await page.goto("/examples/vanilla-js-notes-app/?latencyMs=50");
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await expect(page.locator("#client-b .client-body")).toBeVisible();
		await disableAutoSync(page, "#client-a", "#client-b");

		await page.fill("#client-a .note-input", "Meeting notes");
		await page.click("#client-a .add-btn");
		const seedItem = page.locator("#client-a .notes-list li", {
			hasText: "Meeting notes",
		});
		const noteId = await seedItem.getAttribute("data-id");
		const aRow = page.locator(`#client-a li[data-id="${noteId}"]`);
		const bRow = page.locator(`#client-b li[data-id="${noteId}"]`);

		await page.click("#client-a .push-btn");
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);
		await page.click("#client-b .pull-btn");
		await expect(bRow).toBeVisible();

		// B opens the edit form and starts typing -- does NOT save yet.
		await bRow.locator(".edit-btn").click();
		await bRow.locator(".edit-textarea").fill("B is drafting...");

		// Meanwhile A edits and pushes the SAME note.
		await aRow.locator(".edit-btn").click();
		await aRow.locator(".edit-textarea").fill("Updated by A");
		await aRow.locator(".save-btn").click();
		await page.click("#client-a .push-btn");
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);

		// B pulls while its own form is still open.
		await page.click("#client-b .pull-btn");

		// B's draft must be untouched, and a hint must explain what happened.
		await expect(bRow.locator(".edit-textarea")).toHaveValue(
			"B is drafting...",
		);
		await expect(bRow.locator(".conflict-hint")).toBeVisible();

		// Saving now layers B's draft on top of the latest (A's) state, not the stale original.
		await bRow.locator(".save-btn").click();
		await expect(bRow.locator(".note-text")).toContainText("B is drafting...");
	});

	test("conflicting edits are resolved by the configured merge strategy on pull", async ({
		page,
	}) => {
		// Demo default merge is `custom` (deterministic text combine); keepPendingOnPull must
		// be forced to false here since the default (true) would just keep B's edit optimistic
		// and never invoke merge at all -- this test is specifically about the merge path.
		await page.goto(
			"/examples/vanilla-js-notes-app/?latencyMs=50&keepPendingOnPull=false",
		);
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await expect(page.locator("#client-b .client-body")).toBeVisible();
		await disableAutoSync(page, "#client-a", "#client-b");

		await page.fill("#client-a .note-input", "Shared note");
		await page.click("#client-a .add-btn");
		const seedItem = page.locator("#client-a .notes-list li", {
			hasText: "Shared note",
		});
		const noteId = await seedItem.getAttribute("data-id");
		const aRow = page.locator(`#client-a li[data-id="${noteId}"]`);
		const bRow = page.locator(`#client-b li[data-id="${noteId}"]`);

		await page.click("#client-a .push-btn");
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);
		await page.click("#client-b .pull-btn");
		await expect(bRow).toBeVisible();

		// Diverge: edit the SAME note differently on both sides, without syncing yet.
		await aRow.locator(".edit-btn").click();
		await aRow.locator(".edit-textarea").fill("A version");
		await aRow.locator(".save-btn").click();

		await bRow.locator(".edit-btn").click();
		await bRow.locator(".edit-textarea").fill("B version");
		await bRow.locator(".save-btn").click();

		// Push A's edit to the shared backend, then Pull on B -- B is still dirty, so this
		// forces the still-un-pushed B edit through the configured merge strategy.
		await page.click("#client-a .push-btn");
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);
		await page.click("#client-b .pull-btn");

		await expect(bRow.locator(".note-text")).toContainText(
			"A version ⟷ B version",
			{
				timeout: 5_000,
			},
		);
	});

	test("serverWins merge strategy discards the local edit on pull", async ({
		page,
	}) => {
		// keepPendingOnPull=false forces B's still-dirty edit through the merge path instead
		// of staying optimistic -- see the "conflicting edits" test above for why.
		await page.goto(
			"/examples/vanilla-js-notes-app/?latencyMs=50&merge=serverWins&keepPendingOnPull=false",
		);
		await expect(page.locator("#client-a .client-body")).toBeVisible();
		await expect(page.locator("#client-b .client-body")).toBeVisible();
		await disableAutoSync(page, "#client-a", "#client-b");

		await page.fill("#client-a .note-input", "Shared note");
		await page.click("#client-a .add-btn");
		const seedItem = page.locator("#client-a .notes-list li", {
			hasText: "Shared note",
		});
		const noteId = await seedItem.getAttribute("data-id");
		const aRow = page.locator(`#client-a li[data-id="${noteId}"]`);
		const bRow = page.locator(`#client-b li[data-id="${noteId}"]`);

		await page.click("#client-a .push-btn");
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);
		await page.click("#client-b .pull-btn");
		await expect(bRow).toBeVisible();

		await bRow.locator(".edit-btn").click();
		await bRow
			.locator(".edit-textarea")
			.fill("B version (should be discarded)");
		await bRow.locator(".save-btn").click();

		await aRow.locator(".edit-btn").click();
		await aRow.locator(".edit-textarea").fill("A version (server)");
		await aRow.locator(".save-btn").click();
		await page.click("#client-a .push-btn");
		await expect(page.locator("#client-a .pending-badge")).toHaveText(
			"0 pending",
			{
				timeout: 5_000,
			},
		);

		await page.click("#client-b .pull-btn");
		await expect(bRow.locator(".note-text")).toContainText(
			"A version (server)",
			{
				timeout: 5_000,
			},
		);
	});
});
