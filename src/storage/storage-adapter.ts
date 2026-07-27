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

export interface StorageAdapter {
	/** Read one record by id, or `undefined` if not found. */
	read(collection: string, id: string): Promise<StoredRecord | undefined>;
	/** Read every record in a collection (including tombstones). */
	readAll(collection: string): Promise<StoredRecord[]>;
	/** Write a record (insert or update) keyed by `record.id`. */
	write(collection: string, record: StoredRecord): Promise<void>;
	/** Write many records (insert or update) in a single batch. */
	writeMany(
		collection: string,
		records: readonly StoredRecord[],
	): Promise<void>;
	/** Hard-delete a record by id. */
	remove(collection: string, id: string): Promise<void>;
	/** Hard-delete all records in a collection. */
	clear(collection: string): Promise<void>;
	/** Close the adapter, releasing any resources. Adapters may reopen after being closed. */
	close(): Promise<void>;
}
