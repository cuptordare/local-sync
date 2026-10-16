import type { StorageAdapter, StoredEntry } from "./storage-adapter.js";
import { mergeStored } from "./storage-adapter.js";

export function createMemoryAdapter(): StorageAdapter {
	const collections = new Map<string, Map<string, StoredEntry>>();

	const collectionMap = (name: string): Map<string, StoredEntry> => {
		let map = collections.get(name);
		if (!map) {
			map = new Map();
			collections.set(name, map);
		}
		return map;
	};

	return {
		readAll(collection) {
			return Promise.resolve(structuredClone(collectionMap(collection)));
		},

		merge(collection, changes) {
			// Synchronous, so nothing else can run between the read and the write.
			const map = collectionMap(collection);
			const result = new Map<string, StoredEntry>();
			for (const [key, incoming] of changes) {
				const merged = mergeStored(map.get(key), structuredClone(incoming));
				map.set(key, merged);
				result.set(key, structuredClone(merged));
			}
			return Promise.resolve(result);
		},

		remove(collection, keys) {
			const map = collectionMap(collection);
			for (const key of keys) map.delete(key);
			return Promise.resolve();
		},

		close() {
			// Nothing to release; data is reachable as long as the adapter is.
			return Promise.resolve();
		},
	};
}
