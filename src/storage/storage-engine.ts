/**
 * WHAT THIS IS — storage-engine (the persistence coordinator)
 *
 * The single point of contact for the library to read/write records. It wraps a `StorageAdapter`
 * and provides a few convenience methods (like `hydrate()` to read a whole collection into a Map).
 */
import type {
	StorageAdapter,
	StorageChanges,
	StoredRecord,
} from "./storage-adapter.js";

export interface StorageEngine {
	read(collection: string, id: string): Promise<StoredRecord | undefined>;
	/** Read several records (same order as `ids`; `undefined` where missing). */
	readMany(
		collection: string,
		ids: readonly string[],
	): Promise<Array<StoredRecord | undefined>>;
	readAll(collection: string): Promise<StoredRecord[]>;
	/** Read a whole collection into an id-keyed Map (used to hydrate in-memory state). */
	hydrate(collection: string): Promise<Map<string, StoredRecord>>;
	write(collection: string, record: StoredRecord): Promise<void>;
	writeMany(
		collection: string,
		records: readonly StoredRecord[],
	): Promise<void>;
	/**
	 * Read these records, let `decide` choose what to write and remove, and apply it -- atomically
	 * if the adapter supports `update` (see `StorageAdapter.update`).
	 */
	update(
		collection: string,
		ids: readonly string[],
		decide: (stored: Array<StoredRecord | undefined>) => StorageChanges,
	): Promise<void>;
	remove(collection: string, id: string): Promise<void>;
	removeMany(collection: string, ids: readonly string[]): Promise<void>;
	clear(collection: string): Promise<void>;
	close(): Promise<void>;
}

export function createStorageEngine(adapter: StorageAdapter): StorageEngine {
	const readMany: StorageEngine["readMany"] = (collection, ids) =>
		adapter.readMany !== undefined
			? adapter.readMany(collection, ids)
			: Promise.all(ids.map((id) => adapter.read(collection, id)));

	const removeMany: StorageEngine["removeMany"] = async (collection, ids) => {
		if (ids.length === 0) return;
		if (adapter.removeMany !== undefined) {
			return adapter.removeMany(collection, ids);
		}
		for (const id of ids) await adapter.remove(collection, id);
	};

	return {
		read: (collection, id) => adapter.read(collection, id),
		readMany,
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
		update: async (collection, ids, decide) => {
			if (adapter.update !== undefined) {
				return adapter.update(collection, ids, decide);
			}
			// Not atomic: another writer could change the records between the read and the write.
			const { write, remove } = decide(await readMany(collection, ids));
			if (write.length > 0) await adapter.writeMany(collection, write);
			await removeMany(collection, remove);
		},
		remove: (collection, id) => adapter.remove(collection, id),
		removeMany,
		clear: (collection) => adapter.clear(collection),
		close: () => adapter.close(),
	};
}
