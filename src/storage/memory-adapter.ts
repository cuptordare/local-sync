import type { StorageAdapter, StoredRecord } from "./storage-adapter.js";

export function createMemoryAdapter(): StorageAdapter {
	const collections = new Map<string, Map<string, StoredRecord>>();

	const collectionMap = (name: string): Map<string, StoredRecord> => {
		let map = collections.get(name);
		if (!map) {
			map = new Map<string, StoredRecord>();
			collections.set(name, map);
		}
		return map;
	};

	return {
		read(collection, id) {
			const record = collectionMap(collection).get(id);
			return Promise.resolve(
				record === undefined ? undefined : structuredClone(record),
			);
		},

		readAll(collection) {
			const records = [...collectionMap(collection).values()].map((r) =>
				structuredClone(r),
			);
			return Promise.resolve(records);
		},

		write(collection, record) {
			collectionMap(collection).set(record.id, structuredClone(record));
			return Promise.resolve();
		},

		writeMany(collection, records) {
			const map = collectionMap(collection);
			for (const record of records) {
				map.set(record.id, structuredClone(record));
			}
			return Promise.resolve();
		},

		remove(collection, id) {
			collectionMap(collection).delete(id);
			return Promise.resolve();
		},

		clear(collection) {
			collections.delete(collection);
			return Promise.resolve();
		},

		close() {
			// Nothing to release; data is reachable as long as the adapter is.
			return Promise.resolve();
		},
	};
}
