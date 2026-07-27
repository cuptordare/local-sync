/**
 * WHAT THIS IS — storage-engine (the persistence coordinator)
 *
 * The single point of contact for the library to read/write records. It wraps a `StorageAdapter`
 * and provides a few convenience methods (like `hydrate()` to read a whole collection into a Map).
 */
import type { StorageAdapter, StoredRecord } from "./storage-adapter.js";

export interface StorageEngine {
	read(collection: string, id: string): Promise<StoredRecord | undefined>;
	readAll(collection: string): Promise<StoredRecord[]>;
	/** Read a whole collection into an id-keyed Map (used to hydrate in-memory state). */
	hydrate(collection: string): Promise<Map<string, StoredRecord>>;
	write(collection: string, record: StoredRecord): Promise<void>;
	writeMany(
		collection: string,
		records: readonly StoredRecord[],
	): Promise<void>;
	remove(collection: string, id: string): Promise<void>;
	clear(collection: string): Promise<void>;
	close(): Promise<void>;
}

export function createStorageEngine(adapter: StorageAdapter): StorageEngine {
	return {
		read: (collection, id) => adapter.read(collection, id),
		readAll: (collection) => adapter.readAll(collection),
		hydrate: async (collection) => {
			const records = await adapter.readAll(collection);
			const map = new Map<string, StoredRecord>();
			for (const record of records) {
				map.set(record.id, record);
			}
			return map;
		},
		write: (collection, record) => adapter.write(collection, record),
		writeMany: (collection, records) => adapter.writeMany(collection, records),
		remove: (collection, id) => adapter.remove(collection, id),
		clear: (collection) => adapter.clear(collection),
		close: () => adapter.close(),
	};
}
