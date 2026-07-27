import { custom } from "@localsync";

// A deterministic "combine both edits" strategy for the two-panel conflict demo.
// Deterministic on purpose -- unlike lastWriteWins(), which depends on wall-clock
// timing between two manually-typed edits, this always produces the same result,
// which is what makes it a sane *default* for a demo (and for e2e assertions).
//
// The combined record is marked dirty so it gets pushed back to the server -- a
// merge resolves the LOCAL collection's state, it doesn't by itself tell the
// remote about the outcome.
export function combineText() {
	return custom((local, remote) => {
		if (local.data.text === remote.data.text) {
			return {
				...remote,
				meta: { ...remote.meta, source: "remote", dirty: false },
			};
		}
		return {
			id: remote.id,
			data: { text: `${remote.data.text} ⟷ ${local.data.text}` },
			meta: {
				...remote.meta,
				version: Math.max(local.meta.version, remote.meta.version),
				source: "local",
				dirty: true,
			},
		};
	});
}
