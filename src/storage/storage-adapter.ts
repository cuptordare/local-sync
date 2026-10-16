/**
 * WHAT THIS IS — storage-adapter (the persistence contract)
 *
 * The library is storage-agnostic: it needs a `StorageAdapter` that keeps, per collection,
 * one `StoredEntry` per key. Writes are MERGES, never blind overwrites: the adapter keeps
 * whichever entry is newer (see lww-map.ts), so any tab can write at any time and an older
 * write can never replace a newer one. IndexedDB and in-memory adapters are built in.
 */
import type { Entry, Mark } from "../crdt/lww-map.js";
import { compareEntries, laterMark, newerEntry } from "../crdt/lww-map.js";

/** What is stored per key. */
export interface StoredEntry {
	entry: Entry;
	/** The newest write of this key the remote is known to hold (absent: never synced). */
	synced?: Mark;
	/** For an unsaved edit: the entry it was made from (used to merge concurrent edits). */
	base?: Entry;
}

export interface StorageAdapter {
	/** Every stored entry of a collection (tombstones too). Must return copies. */
	readAll(collection: string): Promise<Map<string, StoredEntry>>;
	/**
	 * Merge `changes` into the stored entries as ONE atomic step (e.g. one IndexedDB readwrite
	 * transaction): per key, keep the newer entry and the later `synced` mark (`mergeStored`).
	 * Resolves with the stored result for those keys.
	 */
	merge(
		collection: string,
		changes: ReadonlyMap<string, StoredEntry>,
	): Promise<Map<string, StoredEntry>>;
	/** Delete keys outright (a read-only source drops items gone from its snapshot). */
	remove(collection: string, keys: readonly string[]): Promise<void>;
	/**
	 * Optional: the records an older version of this library stored for `collection`, which
	 * are imported on load (see migration/legacy.ts). The IndexedDB adapter implements it.
	 */
	readLegacy?(collection: string): Promise<unknown[]>;
	/** Release resources. Adapters may reopen after being closed. */
	close(): Promise<void>;
}

/**
 * The merge every adapter applies per key: the newer entry (with its base), and the later
 * synced mark.
 */
export function mergeStored(
	stored: StoredEntry | undefined,
	incoming: StoredEntry,
): StoredEntry {
	if (stored === undefined) return incoming;
	const entry = newerEntry(stored.entry, incoming.entry) as Entry;
	const synced = laterMark(stored.synced, incoming.synced);
	// The base belongs to its edit; for the same edit, the later (further rebased) one.
	const base =
		compareEntries(stored.entry, incoming.entry) === 0
			? laterMark(stored.base, incoming.base)
			: entry === stored.entry
				? stored.base
				: incoming.base;
	return {
		entry,
		...(synced !== undefined ? { synced } : {}),
		...(base !== undefined ? { base: base as Entry } : {}),
	};
}
