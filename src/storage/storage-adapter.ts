/**
 * WHAT THIS IS — storage-adapter (the persistence contract)
 *
 * The library is storage-agnostic: it doesn't care whether you store records
 * in IndexedDB, SQLite, Postgres, or a JSON file. It just needs a `StorageAdapter`
 * that implements the interface below. The library provides a few built-in
 * adapters, but you can also implement your own.
 */
import type { RecordEnvelope } from "../records/record-envelope.js";

/** What adapters store: an envelope with an unknown data payload. */
export type StoredRecord = RecordEnvelope<unknown>;

/** Records to write and ids to remove, as decided inside an atomic `update`. */
export interface StorageChanges {
	write: readonly StoredRecord[];
	remove: readonly string[];
}

export interface StorageAdapter {
	/** Read one record by id, or `undefined` if not found. Must return a copy (see `readAll`). */
	read(collection: string, id: string): Promise<StoredRecord | undefined>;
	/**
	 * Read every record in a collection (including tombstones). Must return copies the caller
	 * may keep: collections deep-freeze what they load, so handing out objects the adapter
	 * itself still holds and mutates would break it.
	 */
	readAll(collection: string): Promise<StoredRecord[]>;
	/** Write a record (insert or update) keyed by `record.id`. */
	write(collection: string, record: StoredRecord): Promise<void>;
	/** Write many records (insert or update) in a single batch. */
	writeMany(
		collection: string,
		records: readonly StoredRecord[],
	): Promise<void>;
	/**
	 * Optional: read several records in one batch (same order as `ids`, `undefined` where
	 * missing). Without it, `read` is called once per id.
	 */
	readMany?(
		collection: string,
		ids: readonly string[],
	): Promise<Array<StoredRecord | undefined>>;
	/**
	 * Optional, but needed for safe multi-tab use: read these records, pass them to `decide`
	 * (same order as `ids`, `undefined` where missing), and apply the writes and removals it
	 * returns -- all as ONE atomic step (e.g. one IndexedDB readwrite transaction), so no other
	 * writer can change the records in between. `decide` is synchronous. Without it, the
	 * library reads, then writes, and another tab's write can slip in between.
	 */
	update?(
		collection: string,
		ids: readonly string[],
		decide: (stored: Array<StoredRecord | undefined>) => StorageChanges,
	): Promise<void>;
	/** Hard-delete a record by id. */
	remove(collection: string, id: string): Promise<void>;
	/** Optional: hard-delete several records in one batch. Without it, `remove` is called per id. */
	removeMany?(collection: string, ids: readonly string[]): Promise<void>;
	/** Hard-delete all records in a collection. */
	clear(collection: string): Promise<void>;
	/** Close the adapter, releasing any resources. Adapters may reopen after being closed. */
	close(): Promise<void>;
}
