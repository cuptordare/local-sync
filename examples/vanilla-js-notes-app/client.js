import {
	createIndexedDBAdapter,
	createLocalSyncApp,
	createNetworkStatus,
	createSyncEngine,
	ValidationError,
} from "localsync";
import { noteValidator } from "./note-validator.js";

// Builds one full client "panel": its own app/collection/storage/engine, plus all the
// DOM wiring for one <section class="client"> mounted from the shared <template>. Two
// of these, pointed at one shared mock backend, are what let this example demonstrate
// multi-user editing without needing two real browser tabs.
export function createClient({ label, root, backend }) {
	// Real persistence -- notes survive a reload, unlike the old in-memory-only example.
	// Each client uses an EXPLICIT, distinct databaseName: if two createLocalSyncApp()
	// instances both omitted it, they'd collide on IndexedDB's default "app"/v1 (see
	// README's Storage adapters section) and silently share/stomp each other's data.
	const app = createLocalSyncApp({
		storage: createIndexedDBAdapter({
			databaseName: `localsync-notes-demo-${label}`,
		}),
	});

	// Concurrent edits to one note resolve per note: the later edit wins, on every client
	// (see the README's "Sync semantics"). No merge code to write.
	const notes = app.collection("notes", { validator: noteValidator });

	// Each panel's online toggle is independent of the real browser network, so the demo
	// isn't at the mercy of your actual wifi -- `watch` is overridden to a no-op source.
	const network = createNetworkStatus({
		initialStatus: true,
		watch: () => () => {},
	});

	const engine = createSyncEngine({
		collection: notes,
		adapter: backend.forClient(label),
		network,
		retry: { maxAttempts: 2 }, // shortened so the error banner (see "simulate server error") is reachable quickly
	});

	// Auto-sync ON by default: push shortly after every change AND poll for remote changes
	// periodically -- this is what most real apps actually do, and a recipe example should
	// default to it rather than requiring a developer to click buttons just to see basic
	// sync happen. `pushOnChange` is debounced (500ms by default; tune it with
	// `pushOnChange: { debounceMs }`), so even live-as-you-type autosave becomes one push
	// per pause rather than one per keystroke.
	const AUTO_SYNC_INTERVAL_MS = 4000;
	function startAutoSync() {
		engine.start({
			pushOnChange: true,
			syncOnStart: true,
			intervalMs: AUTO_SYNC_INTERVAL_MS,
		});
	}
	startAutoSync();

	// --- DOM ---
	const $ = (sel) => root.querySelector(sel);
	const loading = $(".loading");
	const body = $(".client-body");
	const noteInput = $(".note-input");
	const addBtn = $(".add-btn");
	const topLevelError = $(".top-level-error");
	const autoSyncToggle = $(".autosync-toggle");
	const pushBtn = $(".push-btn");
	const pullBtn = $(".pull-btn");
	const syncBtn = $(".sync-btn");
	const pauseBtn = $(".pause-btn");
	const statusPhase = $(".status-phase");
	const pendingBadge = $(".pending-badge");
	const errorBanner = $(".error-banner");
	const errorMessage = $(".error-message");
	const retryBtn = $(".retry-btn");
	const netPill = $(".net");
	const onlineToggle = $(".online-toggle");
	const list = $(".notes-list");

	app.ready().then(() => {
		loading.hidden = true;
		body.hidden = false;
	});

	// id -> { unsubscribe } for notes currently being edited in THIS panel. See
	// openEditForm() below for why this exists -- it's the central pattern this example
	// exists to demonstrate.
	const editSessions = new Map();
	const rowSelector = (id) => `li[data-id="${CSS.escape(id)}"]`;

	function buildNoteItem(record) {
		const li = document.createElement("li");
		li.dataset.id = record.id;

		const view = document.createElement("div");
		view.className = "note-view";
		const textLabel = document.createElement("span");
		textLabel.className = "note-text";
		textLabel.textContent = record.data.text;
		if (notes.pending().includes(record.id)) {
			const tag = document.createElement("span");
			tag.className = "unsynced";
			tag.textContent = "unsynced";
			textLabel.appendChild(tag);
		}
		view.appendChild(textLabel);

		const actions = document.createElement("span");
		actions.className = "note-actions";
		const editBtn = document.createElement("button");
		editBtn.type = "button";
		editBtn.className = "edit-btn";
		editBtn.textContent = "Edit";
		editBtn.addEventListener("click", () => openEditForm(li, record));
		const delBtn = document.createElement("button");
		delBtn.type = "button";
		delBtn.className = "delete-btn";
		delBtn.textContent = "✕";
		delBtn.addEventListener("click", () => notes.delete(record.id));
		actions.append(editBtn, delBtn);
		view.appendChild(actions);

		const editForm = document.createElement("div");
		editForm.className = "edit-form";
		editForm.hidden = true;
		const textarea = document.createElement("textarea");
		textarea.className = "edit-textarea";
		textarea.rows = 2;
		const hint = document.createElement("p");
		hint.className = "conflict-hint";
		hint.hidden = true;
		const errorEl = document.createElement("p");
		errorEl.className = "validation-error";
		errorEl.hidden = true;
		const formActions = document.createElement("div");
		const saveBtn = document.createElement("button");
		saveBtn.type = "button";
		saveBtn.className = "save-btn";
		saveBtn.textContent = "Save";
		saveBtn.addEventListener("click", () => saveEdit(li, record.id));
		const cancelBtn = document.createElement("button");
		cancelBtn.type = "button";
		cancelBtn.className = "cancel-btn";
		cancelBtn.textContent = "Cancel";
		cancelBtn.addEventListener("click", () => closeEditForm(record.id));
		formActions.append(saveBtn, cancelBtn);
		editForm.append(textarea, hint, errorEl, formActions);

		li.append(view, editForm);
		return li;
	}

	// The pending-synced-state pattern: while a note's edit form is open, incoming remote
	// updates (e.g. the OTHER panel pushed a change to this same note) must NOT be applied
	// straight into the textarea, or the user's in-progress typing gets silently yanked out
	// from under them. The draft isn't saved until Save, so the collection can't protect
	// it -- a pull would show the newer value right away. So instead of binding
	// the textarea to the live query, we subscribe separately, buffer the update, and only
	// surface a hint -- the user's draft stays untouched until they explicitly Save or Cancel.
	function openEditForm(li, record) {
		if (editSessions.has(record.id)) return;
		const editForm = li.querySelector(".edit-form");
		const textarea = editForm.querySelector(".edit-textarea");
		const hint = editForm.querySelector(".conflict-hint");
		const errorEl = editForm.querySelector(".validation-error");

		// Reads are frozen: copy the text into the textarea, which is the scratch buffer.
		textarea.value = record.data.text;
		hint.hidden = true;
		errorEl.hidden = true;
		editForm.hidden = false;
		li.classList.add("editing");

		const unsubscribe = notes.get(record.id).subscribe((updated) => {
			if (updated === undefined) {
				hint.hidden = false;
				hint.textContent =
					"This note was deleted elsewhere. Cancel to remove it here too.";
				return;
			}
			hint.hidden = false;
			hint.textContent =
				"Updated elsewhere while you were editing -- your draft is untouched. " +
				"Save to layer your edit on top, or Cancel to see the latest.";
		});
		editSessions.set(record.id, { unsubscribe });
	}

	// Closing an edit session (Save or Cancel) always forces a fresh render() of this row.
	// This matters for two reasons: (1) notes.update() below notifies the list subscription
	// SYNCHRONOUSLY, before this function's caller gets a chance to remove the id from
	// editSessions -- without a forced re-render afterward, the row would keep showing the
	// stale "still editing" DOM. (2) On Cancel, any remote update that arrived while the
	// form was open was deliberately buffered (never applied to the DOM, see openEditForm)
	// -- closing needs to "catch up" the row to that latest state, same idea as the
	// pause/resume catch-up below.
	function closeEditForm(id) {
		const session = editSessions.get(id);
		if (session) {
			session.unsubscribe();
			editSessions.delete(id);
		}
		render(activeNotes.getCurrentResult());
	}

	function saveEdit(li, id) {
		const textarea = li.querySelector(".edit-textarea");
		const errorEl = li.querySelector(".validation-error");
		try {
			// The saved edit is stamped after everything this client has seen, so it wins
			// over whatever arrived while the form was open (and is pushed as the latest).
			notes.update(id, { text: textarea.value });
			closeEditForm(id);
		} catch (err) {
			if (err instanceof ValidationError) {
				errorEl.hidden = false;
				errorEl.textContent = err.issues.map((i) => i.message).join("; ");
			} else {
				throw err;
			}
		}
	}

	function render(rows) {
		const rowIds = new Set(rows.map((r) => r.id));
		const children = rows.map((record) => {
			if (editSessions.has(record.id)) {
				// An edit form is open for this note -- reuse its existing DOM node rather
				// than rebuilding it, or the open textarea/edit state would be destroyed.
				const existing = list.querySelector(rowSelector(record.id));
				if (existing) return existing;
			}
			return buildNoteItem(record);
		});
		// Keep a note visible (with its "deleted elsewhere" hint) if it's mid-edit even
		// though it dropped out of the live query results (e.g. deleted remotely).
		for (const id of editSessions.keys()) {
			if (!rowIds.has(id)) {
				const li = list.querySelector(rowSelector(id));
				if (li) children.push(li);
			}
		}
		list.replaceChildren(...children);
	}

	const activeNotes = notes.query();
	render(activeNotes.getCurrentResult());
	let unsubscribeList = activeNotes.subscribe(render);

	// --- Mutations ---
	addBtn.addEventListener("click", () => {
		const text = noteInput.value.trim();
		if (text === "") return;
		try {
			notes.insert({ text });
			noteInput.value = "";
			noteInput.focus();
			topLevelError.hidden = true;
		} catch (err) {
			if (err instanceof ValidationError) {
				topLevelError.hidden = false;
				topLevelError.textContent = err.issues.map((i) => i.message).join("; ");
			} else {
				throw err;
			}
		}
	});

	// The one knob for pausing automation -- for deliberately orchestrating an edge case
	// (the concurrent-edit walkthrough, the error/retry demo), not something a real app's user
	// would normally see. engine.stop() halts both pushOnChange and interval polling;
	// re-checking resumes them exactly as at startup.
	autoSyncToggle.addEventListener("change", (event) => {
		if (event.currentTarget.checked) {
			startAutoSync();
		} else {
			engine.stop();
		}
	});

	// Push and Pull are exposed separately (not just the combined Sync) so the walkthrough
	// can push ONE side only, then pull the other, and watch how concurrent edits resolve.
	pushBtn.addEventListener("click", () => void engine.push().catch(() => {}));
	pullBtn.addEventListener("click", () => void engine.pull().catch(() => {}));
	syncBtn.addEventListener("click", () => void engine.sync().catch(() => {}));

	pauseBtn.addEventListener("click", () => {
		if (unsubscribeList) {
			unsubscribeList();
			unsubscribeList = null;
			pauseBtn.textContent = "Resume live updates";
		} else {
			unsubscribeList = activeNotes.subscribe(render);
			render(activeNotes.getCurrentResult()); // catch up on whatever changed while paused
			pauseBtn.textContent = "Pause live updates";
		}
	});

	// --- Structured status / error UI ---
	// `phase` is "syncing" while a pull/push runs, "error" after one fails (with the reason
	// in `lastError`), and back to "idle" after the next success.
	engine.on("sync:start", ({ direction }) => {
		statusPhase.textContent = `syncing (${direction})…`;
	});
	engine.status.subscribe((state) => {
		if (state.phase !== "syncing") {
			statusPhase.textContent =
				state.phase === "error" ? "error (last attempt failed)" : "idle";
		}
		pendingBadge.textContent = `${state.pending} pending`;
		// "unsynced" tags follow what's pending, which can change without any note changing.
		if (unsubscribeList) render(activeNotes.getCurrentResult());
		if (state.lastError !== undefined) {
			errorBanner.hidden = false;
			errorMessage.textContent = state.lastError;
		} else {
			errorBanner.hidden = true;
		}
	});
	// Per the README's documented error-handling asymmetry: paths the engine triggers on
	// its own (pushOnChange, interval polling, or the reconnect-triggered sync below) swallow
	// errors and only surface them here / via engine.status -- they never reject. Direct
	// calls (the Push/Pull/Sync/Retry buttons) DO reject, which is why every direct call
	// above has its own `.catch(() => {})`. Both `sync:error` and `engine.status` matter:
	// the event is "something just failed" (good for logging), the status is "what's true
	// right now" (good for a persistent UI banner) -- this app uses status for the banner
	// and the event for the console, deliberately showing both.
	engine.on("sync:error", ({ phase, error }) => {
		console.warn(`[${label}] sync error during ${phase}:`, error);
	});
	retryBtn.addEventListener("click", () => void engine.sync().catch(() => {}));

	// --- Network toggle ---
	const renderNet = (online) => {
		netPill.textContent = online ? "online" : "offline";
		netPill.classList.toggle("online", online);
		netPill.classList.toggle("offline", !online);
	};
	renderNet(network.isOnline());
	network.subscribe(renderNet);
	onlineToggle.addEventListener("click", () =>
		network.set(!network.isOnline()),
	);

	// Multi-tab coordination is NOT used here: it keeps several TABS of one app on one
	// device in step (createLocalSyncApp does it automatically when given a `name`). Client
	// A/B in this demo represent two DIFFERENT devices, each with its own storage.

	return { app, notes, engine, network };
}
