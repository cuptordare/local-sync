// A single shared, in-memory "server" that BOTH client panels sync against. Unlike a
// mock created fresh per page load, this one Map is passed to both clients, so their
// edits genuinely race for the same backend data -- the mechanism the two-panel
// conflict demo depends on. Also injectable failure, so the retry/error-banner path
// (dead code in a mock that never fails) is actually reachable.
export function createMockBackend({ latencyMs = 1200 } = {}) {
	const records = new Map();
	let failing = false;

	const wait = () => new Promise((resolve) => setTimeout(resolve, latencyMs));

	return {
		setFailing(value) {
			failing = value;
		},
		isFailing() {
			return failing;
		},
		// One SyncAdapter per client label, all reading/writing the same `records` Map.
		forClient(label) {
			return {
				async pull() {
					await wait();
					if (failing) {
						throw new Error(
							`[mock server] simulated failure (pull, from ${label})`,
						);
					}
					return { records: [...records.values()] };
				},
				async push(mutations) {
					await wait();
					if (failing) {
						throw new Error(
							`[mock server] simulated failure (push, from ${label})`,
						);
					}
					const acked = [];
					const returned = [];
					for (const m of mutations) {
						const authoritative = {
							...m.record,
							meta: { ...m.record.meta, source: "remote", dirty: false },
						};
						records.set(m.recordId, authoritative);
						acked.push(m.mutationId);
						returned.push(authoritative);
					}
					return { acked, records: returned };
				},
			};
		},
	};
}
