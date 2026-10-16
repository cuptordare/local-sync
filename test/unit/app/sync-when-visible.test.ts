import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLocalSyncApp } from "../../../src/app/create-local-sync-app.js";
import { createFakeClock } from "../support/fake-clock.js";
import { createFakeNetworkStatus } from "../support/fake-network-status.js";

/** A minimal stand-in for the browser `document` (Node has none). */
function installFakeDocument() {
	const target = new EventTarget() as EventTarget & {
		visibilityState: DocumentVisibilityState;
	};
	target.visibilityState = "visible";
	(globalThis as { document?: unknown }).document = target;
	return {
		show() {
			target.visibilityState = "visible";
			target.dispatchEvent(new Event("visibilitychange"));
		},
		hide() {
			target.visibilityState = "hidden";
			target.dispatchEvent(new Event("visibilitychange"));
		},
	};
}

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("syncWhenVisible", () => {
	let page: ReturnType<typeof installFakeDocument>;
	beforeEach(() => {
		page = installFakeDocument();
	});
	afterEach(() => {
		delete (globalThis as { document?: unknown }).document;
	});

	function setup(syncWhenVisible?: boolean) {
		const clock = createFakeClock(1_000_000);
		let pulls = 0;
		const app = createLocalSyncApp({
			now: clock.now,
			network: createFakeNetworkStatus(true),
			...(syncWhenVisible === undefined ? {} : { syncWhenVisible }),
		});
		app.keyValue<{ v: number }>("items", {
			remote: {
				read: async () => {
					pulls++;
					return { entries: new Map() };
				},
			},
		});
		return { app, clock, pulls: () => pulls };
	}

	it("syncs when the user comes back to the page", async () => {
		const t = setup();
		await wait(); // initial sync
		assert.equal(t.pulls(), 1);
		t.clock.advance(60_000);
		page.hide();
		page.show();
		await wait();
		assert.equal(t.pulls(), 2);
		await t.app.close();
	});

	it("skips collections that synced moments ago (quick tab switches)", async () => {
		const t = setup();
		await wait();
		t.clock.advance(1_000);
		page.show();
		await wait();
		assert.equal(t.pulls(), 1);
		await t.app.close();
	});

	it("can be turned off", async () => {
		const t = setup(false);
		await wait();
		t.clock.advance(60_000);
		page.show();
		await wait();
		assert.equal(t.pulls(), 1);
		await t.app.close();
	});

	it("stops listening once the app is closed", async () => {
		const t = setup();
		await wait();
		await t.app.close();
		t.clock.advance(60_000);
		page.show();
		await wait();
		assert.equal(t.pulls(), 1);
	});
});
