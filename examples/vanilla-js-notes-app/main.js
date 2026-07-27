// ============================================================================
// localsync — vanilla JS notes app (the "recipe")
// ----------------------------------------------------------------------------
// This file uses ONLY @localsync -- no framework, no JSX, no build step. Two
// independent client "panels" (see client.js) both sync against ONE shared
// mock backend (mock-backend.js), which is what lets this example demonstrate
// real multi-user conflicts, persistence, validation, and error handling --
// not just the wiring, but the patterns you actually need in production.
// ============================================================================

import { createClient } from "./client.js";
import { createMockBackend } from "./mock-backend.js";

// Merge strategy and keepPendingOnPull are fixed at collection/engine construction
// time -- there's no public API to hot-swap them on a live engine. Reading them from
// the URL and reloading on change is the simplest correct way to make the scenario
// controls actually take effect.
const params = new URLSearchParams(location.search);
const mergeMode = params.get("merge") ?? "custom";
// Matches the library's own default (true): a dirty record is never touched by a pull
// until IT gets pushed, regardless of merge strategy -- the only setting that's safe for
// every mutation type (edits AND deletes) with every merge strategy, including serverWins().
// Set `false` (via the dropdown, or ?keepPendingOnPull=false) to explore how a pull racing
// ahead of your own pending push gets resolved instead -- see the README's "Merge strategies"
// section for why that requires a merge strategy that's safe to invoke on a record you
// haven't finished syncing yet.
const keepPendingOnPull = params.get("keepPendingOnPull") !== "false";
// Overridable for fast, deterministic e2e runs (?latencyMs=50); defaults to a
// human-friendly simulated round-trip.
const latencyMs = params.has("latencyMs")
	? Number(params.get("latencyMs"))
	: 1200;

const mergeSelect = document.getElementById("merge-select");
const keepPendingSelect = document.getElementById("keep-pending-select");
mergeSelect.value = mergeMode;
keepPendingSelect.value = String(keepPendingOnPull);

function updateParamAndReload(key, value) {
	const next = new URLSearchParams(location.search);
	next.set(key, value);
	location.search = next.toString();
}
mergeSelect.addEventListener("change", (e) =>
	updateParamAndReload("merge", e.target.value),
);
keepPendingSelect.addEventListener("change", (e) =>
	updateParamAndReload("keepPendingOnPull", e.target.value),
);

const backend = createMockBackend({ latencyMs });
document
	.getElementById("server-error-toggle")
	.addEventListener("change", (e) => {
		backend.setFailing(e.target.checked);
	});

const template = document.getElementById("client-template");

function mount(rootId, label, title) {
	const root = document.getElementById(rootId);
	root.appendChild(template.content.cloneNode(true));
	root.querySelector(".panel-title").textContent = title;
	return createClient({ label, root, backend, mergeMode, keepPendingOnPull });
}

mount("client-a", "a", "Client A");
mount("client-b", "b", "Client B");
