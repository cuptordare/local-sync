/**
 * WHAT THIS IS — record-merge (pluggable conflict resolution)
 *
 * When a pull brings in a remote version of a record that ALSO changed locally,
 * something has to decide the outcome. That decision is a `MergeStrategy`. The
 * library provides a few built-in strategies, but you can also implement your own.
 *
 * serverWins() — the remote version always wins (DEFAULT)
 * Remote is authoritative. The conflicting local edit is DISCARDED (the record becomes the
 * clean remote copy); it is not re-applied later. Listen for the engine's `"conflict"` event
 * if users should be told, or use a strategy that keeps or combines the local change.
 *
 * lastWriteWins() — the higher `meta.version` wins, then the later `meta.updatedAt`
 *
 * custom(fn) — you provide a function that takes the local and remote versions and
 * returns the resolved version. Return it with `meta.dirty: true` if the result still needs
 * pushing (it contains local changes the remote doesn't have yet).
 *
 * Merge is 2-way (local vs remote). Merge is ONLY called on a genuine conflict (both
 * sides exist and both changed); brand-new remote records are inserted without merging.
 * Whatever the strategy returns, the collection records the remote's version on it
 * (`meta.remoteVersion`), so a kept local edit is pushed as "based on" what it was merged with.
 *
 * @example
 *   const app = createLocalSyncApp({ merge: serverWins() }); // default
 *   const app = createLocalSyncApp({ merge: lastWriteWins() });
 *   app.collection<Doc>("docs", {
 *     merge: custom((local, remote) => ({
 *       ...remote,
 *       data: { ...remote.data, notes: `${remote.data.notes}\n${local.data.notes}` },
 *       meta: { ...remote.meta, dirty: true, source: "local" },
 *     })),
 *   });
 *
 * DELETES AND MERGE -- READ THIS: a delete is just a dirty tombstone (`meta.deleted`),
 * so it goes through the exact same conflict path as any other edit. `serverWins()` and a
 * plain `custom()` merge that only compares `data` (not `meta.deleted`) can both silently
 * RESURRECT a delete that hasn't been pushed yet: if a pull races ahead of your delete's
 * push (this is likeliest with `keepPendingOnPull: false`, or with periodic polling since
 * that pull can land on any tick), the still-unaware server copy looks like "no real
 * conflict" and wins. The record then often disappears again on the NEXT pull once the
 * delete finally lands server-side -- a confusing flicker. `lastWriteWins()` mostly avoids
 * this by luck (a delete bumps `meta.version`), but isn't guaranteed to if the remote has
 * since moved further ahead. Wrap any strategy with `preferDeletion()` below if a pending
 * delete should never be silently discarded by a merge.
 */
import type { RecordEnvelope } from "./record-envelope.js";

/** Decides the winning/merged record when local and remote both changed. */
export interface MergeStrategy<T> {
	merge(local: RecordEnvelope<T>, remote: RecordEnvelope<T>): RecordEnvelope<T>;
}

/** A strategy builder usable as an app-wide default. */
export type MergeFactory = <T>() => MergeStrategy<T>;

/** Adopt the remote record as authoritative: source = remote, dirty cleared. */
function takeAuthoritative<T>(remote: RecordEnvelope<T>): RecordEnvelope<T> {
	if (remote.meta.source === "remote" && !remote.meta.dirty) return remote;
	return {
		...remote,
		meta: { ...remote.meta, source: "remote", dirty: false },
	};
}

function isRemoteNewer<T>(
	local: RecordEnvelope<T>,
	remote: RecordEnvelope<T>,
): boolean {
	if (remote.meta.version !== local.meta.version) {
		return remote.meta.version > local.meta.version;
	}
	if (remote.meta.updatedAt !== local.meta.updatedAt) {
		return remote.meta.updatedAt > local.meta.updatedAt;
	}
	return true; // tie-breaker: remote wins
}

/** Server-authoritative: the remote record always wins. */
export function serverWins<T>(): MergeStrategy<T> {
	return { merge: (_local, remote) => takeAuthoritative(remote) };
}

/** Last-write-wins: the higher `meta.version` wins, then the later `meta.updatedAt`. */
export function lastWriteWins<T>(): MergeStrategy<T> {
	return {
		merge: (local, remote) =>
			isRemoteNewer(local, remote) ? takeAuthoritative(remote) : local,
	};
}

/** Wrap a custom merge function as a MergeStrategy. */
export function custom<T>(
	merge: (
		local: RecordEnvelope<T>,
		remote: RecordEnvelope<T>,
	) => RecordEnvelope<T>,
): MergeStrategy<T> {
	return { merge };
}

/**
 * Wrap any MergeStrategy so a tombstone on EITHER side always wins the conflict outright,
 * bypassing the wrapped strategy entirely -- instead of letting it compare `data`/version
 * and potentially resurrect a delete it never knew to look for (see the module doc above).
 * `local` here is always dirty (merge is only invoked on an un-pushed local change), so a
 * deleted `local` is always an unacknowledged pending delete and always wins as-is; a
 * deleted `remote` always wins over a non-deleted, still-pending local edit, discarding
 * that edit -- "the record is gone" is treated as more final than an in-flight edit to it.
 * If your app wants the opposite (an in-progress edit should resurrect/undo a concurrent
 * delete), don't use this wrapper -- that policy is app-specific, not a safe default.
 *
 * @example
 *   app.collection("notes", { merge: preferDeletion(lastWriteWins()) });
 */
export function preferDeletion<T>(
	strategy: MergeStrategy<T>,
): MergeStrategy<T> {
	return {
		merge(local, remote) {
			if (remote.meta.deleted) return takeAuthoritative(remote);
			if (local.meta.deleted) return local;
			return strategy.merge(local, remote);
		},
	};
}
