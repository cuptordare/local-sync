/**
 * The remote contract: read the remote's entries, and write them back if nobody else wrote
 * since that read. The sync engine does the rest -- it merges what it reads, and writes the
 * merge of the remote's entries and its own -- so an adapter only moves data.
 * `createBlobSyncAdapter` turns any "store one JSON document" backend into one.
 */
import type { Entries } from "../crdt/lww-map.js";

export interface RemoteState<T> {
	entries: Entries<T>;
	/** An opaque version of what was read, for a compare-and-swap write (optional). */
	etag?: string;
	/**
	 * Entries imported from an older format (see `createBlobSyncAdapter`'s `legacy`), which the
	 * remote doesn't hold yet. They're merged in as local changes, so the next push saves them.
	 */
	imported?: Entries<T>;
}

export interface WriteOptions {
	/** The `etag` of the read this write is based on (only if the read returned one). */
	ifMatch?: string;
}

/** Nothing (written), or `{ conflict: true }` when an `ifMatch` precondition failed. */
// biome-ignore lint/suspicious/noConfusingVoidType: lets a plain `async () => { await ... }` writer type-check
export type WriteResult = void | { conflict: true };

export interface SyncAdapter<T> {
	/** Read every entry the remote holds. Throw on any failure. */
	read(): Promise<RemoteState<T>>;
	/**
	 * Replace the remote's entries -- unless `ifMatch` is given and the remote changed since
	 * (then return `{ conflict: true }`; the engine reads, merges and tries again). Throw on
	 * any failure. Omit for a read-only remote.
	 */
	write?(entries: Entries<T>, options: WriteOptions): Promise<WriteResult>;
}
