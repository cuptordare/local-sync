// ============================================================================
// localsync recipe: KEY-VALUE DATA shared through a simple remote
// ----------------------------------------------------------------------------
// A shared household shopping list: saved on this device (instant, works
// offline) and synced through a one-blob-per-key server. Nothing is sent while
// you're idle: a save goes out shortly after you change something, and others'
// changes are fetched on load, when you come back to the page, on reconnect,
// and every 30 seconds. The "server activity" panel shows every request.
// ============================================================================
import {
	createBlobSyncAdapter,
	createLocalSyncApp,
	createNetworkStatus,
} from "localsync";
import { createFakeSheetServer } from "./fake-sheet-server.js";

const params = new URLSearchParams(location.search);
// Open this page in another tab with ?device=phone to act as a second device: its own local
// database, sharing the one server. (A second tab of the SAME device shares the database
// instead: edits appear there instantly, and only one of the tabs talks to the server.)
// The other URL overrides below just make the automated tests fast.
const device = params.get("device") ?? "laptop";
const server = createFakeSheetServer({
	latencyMs: Number(params.get("latencyMs") ?? 800),
});
const network = createNetworkStatus(); // follows the browser; the toggle below can override

// 1. One app. Its name is the IndexedDB database the data is saved in.
const app = createLocalSyncApp({ name: `household-demo-${device}`, network });

// 2. A key-value store synced through the server. Every save merges with what's there, per
//    key, so no one's changes are erased; if two people change the SAME key, the later change
//    wins on every device. The list uses ONE KEY PER ITEM, so two people ticking off
//    different items both keep their change (they wouldn't if the whole list were one value).
const shopping = app.keyValue("shopping", {
	remote: createBlobSyncAdapter({
		read: () => server.read("shopping"),
		write: (blob, options) => server.write("shopping", blob, options),
	}),
	syncIntervalMs: Number(params.get("syncMs") ?? 30_000), // catch others' changes while open
});

// ---------------------------------- UI ----------------------------------------
const $ = (selector) => document.querySelector(selector);
$("#device").textContent = device;
$("#other-device").href = `?device=${device === "laptop" ? "phone" : "laptop"}`;

await app.ready(); // stored data is loaded: safe to read and update
$("#loading").hidden = true;
$("#app").hidden = false;

shopping.watchAll((items) => {
	const rows = [...items].sort(([, a], [, b]) => a.addedAt - b.addedAt);
	$("#list").replaceChildren(
		...rows.map(([id, item]) => {
			const li = document.createElement("li");
			li.innerHTML = `<label><input type="checkbox"> <span></span></label><button title="Remove">✕</button>`;
			li.dataset.id = id;
			li.querySelector("span").textContent = item.text;
			li.classList.toggle("done", item.done);
			const box = li.querySelector("input");
			box.checked = item.done;
			box.addEventListener("change", () =>
				shopping.update(id, (current) => ({ ...current, done: box.checked })),
			);
			li.querySelector("button").addEventListener("click", () =>
				shopping.delete(id),
			);
			return li;
		}),
	);
	$("#empty").hidden = items.size > 0;
});

$("#add-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const text = $("#new-item").value.trim();
	if (text === "") return;
	shopping.set(crypto.randomUUID(), { text, done: false, addedAt: Date.now() });
	$("#new-item").value = "";
});

// One status: Saving / Saved / Offline / Error. "Saving…" means YOUR changes haven't reached
// the server yet -- not that a background check for others' changes is running.
function renderStatus(s) {
	const state = !s.online
		? "offline"
		: s.phase === "error"
			? "error"
			: s.pushScheduled || s.pending > 0
				? "saving"
				: "saved";
	$("#status").dataset.state = state;
	$("#status-text").textContent = {
		offline: `Offline -- ${s.pending} change(s) will sync when you're back`,
		error: `Couldn't sync (${s.lastError}). Your changes are safe on this device.`,
		saving: "Saving…",
		saved: `All changes saved${s.lastSyncedAt ? ` · checked ${new Date(s.lastSyncedAt).toLocaleTimeString()}` : ""}`,
	}[state];
	$("#retry").hidden = state !== "error";
}
renderStatus(app.status.get());
app.status.subscribe(renderStatus);
$("#retry").addEventListener("click", () => app.sync().catch(() => {}));

// Server activity: every request this device makes, with its round-trip time.
server.onActivity(({ action, key, ms, outcome, ok }) => {
	const li = document.createElement("li");
	li.classList.toggle("bad", !ok);
	li.textContent = `${new Date().toLocaleTimeString()}  ${action} "${key}" · ${ms} ms · ${outcome}`;
	$("#activity").prepend(li);
	while ($("#activity").children.length > 30) $("#activity").lastChild.remove();
	$("#activity-empty").hidden = true;
});

// Demo controls
$("#offline").addEventListener("change", (e) => network.set(!e.target.checked));
$("#fail").addEventListener("change", (e) =>
	server.setFailing(e.target.checked),
);
$("#reset").addEventListener("click", async () => {
	await app.close(); // (pushes anything pending first -- so reset the server after)
	server.reset();
	indexedDB.deleteDatabase(`household-demo-${device}`);
	location.reload();
});
