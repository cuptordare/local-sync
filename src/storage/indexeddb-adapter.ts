/**
 * ONE object store ("records") in IndexedDB, keyed by a composite `${collection}\0${id}`
 * record id with an index on `collection` for efficient collection reads. This lets collections
 * be created dynamically without needing to create a new object store for each one.
 * `readAll()` and `clear()` use the index.
 *
 * The DB is opened lazily and memoized on first use, so construction is synchronous.
 * `close()` drops the handle; the next operation reopens.
 */
import type { StorageAdapter, StoredRecord } from "./storage-adapter.js";

const STORE = "records";
const BY_COLLECTION = "by_collection";
const SEPARATOR = "\u0000"; // null char, unlikely to appear in a collection name or id

interface StoredEntry {
	key: string;
	collection: string;
	record: StoredRecord;
}

export interface IndexedDBAdapterOptions {
	/** Database name. Defaults to "app". */
	databaseName?: string;
	/** Database version. Defaults to 1. */
	version?: number;
	/** IndexedDB factory to use. Defaults to the global `indexedDB` (browser). */
	indexedDB?: IDBFactory;
}

function compositeKey(collection: string, id: string): string {
	return `${collection}${SEPARATOR}${id}`;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () =>
			reject(tx.error ?? new Error("IndexedDB transaction failed"));
		tx.onabort = () =>
			reject(tx.error ?? new Error("IndexedDB transaction aborted"));
	});
}

function openDatabase(
	factory: IDBFactory,
	name: string,
	version: number,
): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) {
				const store = db.createObjectStore(STORE, { keyPath: "key" });
				store.createIndex(BY_COLLECTION, "collection", { unique: false });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB open failed"));
		request.onblocked = () =>
			reject(new Error("IndexedDB open blocked by another connection"));
	});
}

export function createIndexedDBAdapter(
	options: IndexedDBAdapterOptions = {},
): StorageAdapter {
	const name = options.databaseName ?? "app";
	const version = options.version ?? 1;
	const factory = options.indexedDB ?? indexedDB;

	let dbPromise: Promise<IDBDatabase> | undefined;
	const getDb = (): Promise<IDBDatabase> => {
		if (dbPromise === undefined) {
			// A failed open must not be cached forever -- clear it so the next call retries.
			dbPromise = openDatabase(factory, name, version).catch((err) => {
				dbPromise = undefined;
				throw err;
			});
		}
		return dbPromise;
	};

	return {
		async read(collection, id) {
			const db = await getDb();
			const tx = db.transaction(STORE, "readonly");
			const request = tx.objectStore(STORE).get(compositeKey(collection, id));
			const entry = await promisifyRequest<StoredEntry | undefined>(request);
			await transactionDone(tx);
			return entry?.record;
		},

		async readAll(collection) {
			const db = await getDb();
			const tx = db.transaction(STORE, "readonly");
			const index = tx.objectStore(STORE).index(BY_COLLECTION);
			const request = index.getAll(IDBKeyRange.only(collection));
			const entries = await promisifyRequest<StoredEntry[]>(request);
			await transactionDone(tx);
			return entries.map((entry) => entry.record);
		},

		async write(collection, record) {
			const db = await getDb();
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			const entry: StoredEntry = {
				key: compositeKey(collection, record.id),
				collection,
				record,
			};
			store.put(entry);
			await transactionDone(tx);
		},

		async writeMany(collection, records) {
			const db = await getDb();
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			for (const record of records) {
				const entry: StoredEntry = {
					key: compositeKey(collection, record.id),
					collection,
					record,
				};
				store.put(entry);
			}
			await transactionDone(tx);
		},

		async remove(collection, id) {
			const db = await getDb();
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			store.delete(compositeKey(collection, id));
			await transactionDone(tx);
		},

		async clear(collection) {
			const db = await getDb();
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			const index = store.index(BY_COLLECTION);
			const keys = await promisifyRequest<IDBValidKey[]>(
				index.getAllKeys(IDBKeyRange.only(collection)),
			);
			for (const key of keys) {
				store.delete(key);
			}
			await transactionDone(tx);
		},

		async close() {
			if (dbPromise) {
				const db = await dbPromise;
				db.close();
				dbPromise = undefined;
			}
		},
	};
}
