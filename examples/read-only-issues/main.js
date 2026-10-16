// ============================================================================
// localsync recipe: READ-ONLY DATA pulled from an outside service
// ----------------------------------------------------------------------------
// An issues dashboard (GitHub-style; the same shape works for Jira, Azure DevOps,
// a calendar...). The library pages through the API, keeps a local copy that
// works offline and loads instantly, refreshes it periodically, and removes
// items that disappeared at the source. Everything below "UI" is plain DOM code.
// ============================================================================
import { createLocalSyncApp, createNetworkStatus } from "localsync";
import { createFakeIssueApi } from "./fake-issue-api.js";

const params = new URLSearchParams(location.search);
const api = createFakeIssueApi({
	latencyMs: Number(params.get("latencyMs") ?? 600),
});
window.__api = api; // poke the "source" from the console (or tests): __api.close(3)
const network = createNetworkStatus(); // follows the browser; the toggle below can override

// 1. One app. Its name is the IndexedDB database the cached copy is saved in.
const app = createLocalSyncApp({ name: "issues-demo", network });

// 2. The only API-specific code: fetch ONE page, and say where the next one starts.
async function fetchPage({ filter, cursor }) {
	const url =
		cursor ?? `/repos/${filter.repo}/issues?state=${filter.state}&per_page=10`;
	// Real API: fetch(`https://api.github.com${url}`, { headers: { Authorization: ... } })
	const response = await api.fetch(url);
	// Always THROW on failure. Returning an empty page would tell the library "the source
	// is empty" -- and it would remove everything from the local copy.
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const nextPage = response.headers
		.get("Link")
		?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
	return { items: await response.json(), nextCursor: nextPage }; // no nextCursor = last page
}

// 3. The source. Each refresh is a full snapshot, so closed/deleted issues drop out.
const initialFilter = JSON.parse(
	localStorage.getItem("issues-demo-filter") ?? "null",
) ?? {
	repo: "acme/web",
	state: "open",
};
const issues = app.source("issues", {
	fetchPage,
	getId: (issue) => issue.number,
	filter: initialFilter,
	refreshIntervalMs: Number(params.get("refreshMs") ?? 15_000),
});

// ---------------------------------- UI ----------------------------------------
const $ = (selector) => document.querySelector(selector);
await app.ready(); // the copy saved on this device is loaded -- shown before any network call
$("#loading").hidden = true;
$("#app").hidden = false;

let search = "";
function render() {
	const all = issues.all().sort((a, b) => b.number - a.number);
	const shown = all.filter((i) => i.title.toLowerCase().includes(search));
	$("#count").textContent = `Showing ${shown.length} of ${all.length}`;
	$("#list").replaceChildren(
		...shown.map((issue) => {
			const li = document.createElement("li");
			li.dataset.number = issue.number;
			li.innerHTML = `<span class="num"></span> <span class="title"></span> <span class="labels"></span><div class="muted"></div>`;
			li.querySelector(".num").textContent = `#${issue.number}`;
			li.querySelector(".title").textContent = issue.title;
			li.querySelector(".labels").textContent = issue.labels
				.map((l) => l.name)
				.join(", ");
			li.querySelector(".muted").textContent =
				`${issue.state} · ${issue.user.login} · updated ${new Date(issue.updated_at).toLocaleString()}`;
			return li;
		}),
	);
}
render();
issues.query().subscribe(render); // re-render whenever a refresh changes something

$("#search").addEventListener("input", (e) => {
	search = e.target.value.toLowerCase();
	render();
});

// Changing the filter re-fetches; issues outside the new filter are removed locally.
$("#repo").value = initialFilter.repo;
$("#state").value = initialFilter.state;
for (const select of [$("#repo"), $("#state")]) {
	select.addEventListener("change", () => {
		const next = { repo: $("#repo").value, state: $("#state").value };
		localStorage.setItem("issues-demo-filter", JSON.stringify(next));
		issues.setFilter(next).catch(() => {}); // failures show in the status bar
	});
}
$("#refresh").addEventListener("click", () => issues.refresh().catch(() => {}));

// Status: Refreshing / Up to date / Offline / Error -- the cached copy stays visible throughout.
function renderStatus(s) {
	const state = !s.online
		? "offline"
		: s.phase === "error"
			? "error"
			: s.phase === "syncing"
				? "busy"
				: "ok";
	$("#status").dataset.state = state;
	$("#status-text").textContent = {
		offline: "Offline -- showing the copy saved on this device.",
		error: `Couldn't refresh (${s.lastError}). Showing the saved copy.`,
		busy: "Refreshing…",
		ok: `Up to date${s.lastSyncedAt ? ` · refreshed ${new Date(s.lastSyncedAt).toLocaleTimeString()}` : ""}`,
	}[state];
}
renderStatus(app.status.get());
app.status.subscribe(renderStatus);

// Demo controls
let live;
$("#activity").addEventListener("click", () => api.simulateActivity());
$("#live").addEventListener("change", (e) => {
	clearInterval(live);
	if (e.target.checked) live = setInterval(() => api.simulateActivity(), 3000);
});
$("#offline").addEventListener("change", (e) => network.set(!e.target.checked));
$("#fail").addEventListener("change", (e) => api.setFailing(e.target.checked));
