// A stand-in for the backend small family apps often really use: a Google Sheet behind an
// Apps Script web app that stores ONE JSON blob per key. This one lives in localStorage, so
// every tab on this origin (each pretending to be a different device) shares it, and it
// survives reloads. Every request takes `latencyMs`, like a real network round trip.
//
// It supports an etag (a version number for the whole blob), which is what lets
// createBlobSyncAdapter guarantee that two devices saving at the same moment can't erase each
// other's writes. A real Apps Script does the same with LockService: compare the etag it was
// sent with the one it has, and refuse the write if they differ.
//
// `onActivity` reports each request this device makes, so the page can show what actually
// goes over the network (and when nothing does).

const PREFIX = "household-demo-server-lww:";

export function createFakeSheetServer({ latencyMs = 800 } = {}) {
	let failing = false;
	const listeners = new Set();
	const report = (entry) => {
		for (const listener of listeners) listener(entry);
	};
	// Stored as { blob, etag }: the document the library saves, plus its version.
	const load = (key) =>
		JSON.parse(localStorage.getItem(PREFIX + key) ?? '{"blob":null,"etag":0}');

	// One simulated round trip: wait, then run `handle` (or fail), and report the outcome.
	const request = async (action, key, handle) => {
		const startedAt = Date.now();
		await new Promise((resolve) => setTimeout(resolve, latencyMs));
		const ms = Date.now() - startedAt;
		if (failing) {
			report({
				action,
				key,
				ms,
				outcome: "failed (simulated server error)",
				ok: false,
			});
			throw new Error("Server error (simulated)");
		}
		const { result, outcome, ok = true } = handle();
		report({ action, key, ms, outcome, ok });
		return result;
	};

	return {
		setFailing(value) {
			failing = value;
		},
		onActivity(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		// -> the saved document plus { etag }
		read(key) {
			return request("read", key, () => {
				const { blob, etag } = load(key);
				const live = Object.values(blob?.entries ?? {}).filter(
					(e) => !e.deleted,
				).length;
				return {
					result: { ...blob, etag: String(etag) },
					outcome: `${live} item(s), version ${etag}`,
				};
			});
		},

		// -> nothing, or { conflict: true } if the blob changed since `ifMatch` was read
		write(key, blob, { ifMatch }) {
			return request("write", key, () => {
				const current = load(key);
				if (ifMatch !== undefined && ifMatch !== String(current.etag)) {
					return {
						result: { conflict: true },
						outcome: `refused: changed by another device since version ${ifMatch} -- re-reading`,
						ok: false,
					};
				}
				localStorage.setItem(
					PREFIX + key,
					JSON.stringify({ blob, etag: current.etag + 1 }),
				);
				return {
					result: undefined,
					outcome: `saved as version ${current.etag + 1}`,
				};
			});
		},

		reset() {
			for (const key of Object.keys(localStorage)) {
				if (key.startsWith(PREFIX)) localStorage.removeItem(key);
			}
		},
	};
}
