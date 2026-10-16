import { createBlobSyncAdapter } from "localsync";

// A single shared, in-memory "server" that BOTH client panels sync against: one JSON
// document with an etag, like a Sheets cell behind an Apps Script. Since the same document
// is shared by both clients, their edits genuinely race for it. Failure is injectable, so
// the retry/error-banner path is actually reachable.
export function createMockBackend({ latencyMs = 1200 } = {}) {
	let blob = null;
	let etag = 0;
	let failing = false;

	const wait = () => new Promise((resolve) => setTimeout(resolve, latencyMs));
	const fail = (what, label) => {
		throw new Error(`[mock server] simulated failure (${what}, from ${label})`);
	};

	return {
		setFailing(value) {
			failing = value;
		},
		isFailing() {
			return failing;
		},
		// One SyncAdapter per client label, all reading/writing the same document.
		forClient(label) {
			return createBlobSyncAdapter({
				async read() {
					await wait();
					if (failing) fail("read", label);
					return { ...structuredClone(blob ?? {}), etag: String(etag) };
				},
				async write(next, { ifMatch }) {
					await wait();
					if (failing) fail("write", label);
					// Saved by the other client since this one read it: refuse, so it re-reads
					// and merges instead of overwriting.
					if (ifMatch !== String(etag)) return { conflict: true };
					blob = structuredClone(next);
					etag++;
				},
			});
		},
	};
}
