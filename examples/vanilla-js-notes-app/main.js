// ============================================================================
// localsync — vanilla JS notes app (the "recipe")
// ----------------------------------------------------------------------------
// This file uses ONLY localsync -- no framework, no JSX, no build step. Two
// independent client "panels" (see client.js) both sync against ONE shared
// mock backend (mock-backend.js), which is what lets this example demonstrate
// real multi-user concurrent edits, persistence, validation, and error handling --
// not just the wiring, but the patterns you actually need in production.
// ============================================================================

import { createClient } from "./client.js";
import { createMockBackend } from "./mock-backend.js";

const params = new URLSearchParams(location.search);
// Overridable for fast, deterministic e2e runs (?latencyMs=50); defaults to a
// human-friendly simulated round-trip.
const latencyMs = params.has("latencyMs")
	? Number(params.get("latencyMs"))
	: 1200;

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
	return createClient({ label, root, backend });
}

mount("client-a", "a", "Client A");
mount("client-b", "b", "Client B");
