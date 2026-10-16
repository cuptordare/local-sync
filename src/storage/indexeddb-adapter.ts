/**
 * ONE object store ("records") in IndexedDB, keyed by a composite `${collection}\0${key}` id,
 * with an index on `collection` for reading a whole collection. Collections can then be
 * created dynamically, without a new object store (or a schema upgrade) for each.
 *
 * Entries are stored under the collection name `lww-1:<collection>`. Earlier versions of this
 * library stored `{ record }` rows under the plain collection name, in this same schema
 * (version 1). Those rows are left as they are -- an old tab still open keeps working, and
 * nothing has to upgrade the database -- and `readLegacy` reads them for the import.
 *
 * The DB is opened lazily and memoized on first use, so construction is synchronous.
 * `close()` drops the handle; the next operation reopens.
 */
import type { StorageAdapter, StoredEntry } from "./storage-adapter.js";
import { mergeStored } from "./storage-adapter.js";

const STORE = "records";
const BY_COLLECTION = "by_collection";
const SEPARATOR = "\u0000"; // null char, unlikely to appear in a collection name or key
const NAMESPACE = "lww-1:";

interface Row {
	key: string;
	collection: string;
	stored?: StoredEntry;
	/** A row written by an earlier version of the library. */
	record?: unknown;
}

export interface IndexedDBAdapterOptions {
	/** Database name. Defaults to "app". */
	databaseName?: string;
	/** IndexedDB factory to use. Defaults to the global `indexedDB` (browser). */
	indexedDB?: IDBFactory;
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

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(name, 1);
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
	const factory = options.indexedDB ?? indexedDB;

	let dbPromise: Promise<IDBDatabase> | undefined;
	const getDb = (): Promise<IDBDatabase> => {
		if (dbPromise === undefined) {
			const opening = openDatabase(factory, name).then(
				(db) => {
					// Another tab (e.g. a newer deploy) needs to upgrade the schema: step aside
					// rather than block it forever. The next operation here reopens.
					db.onversionchange = () => {
						db.close();
						if (dbPromise === opening) dbPromise = undefined;
					};
					return db;
				},
				(err) => {
					// A failed open must not be cached forever -- clear it so the next call retries.
					if (dbPromise === opening) dbPromise = undefined;
					throw err;
				},
			);
			dbPromise = opening;
		}
		return dbPromise;
	};

	const rowsOf = async (collection: string): Promise<Row[]> => {
		const db = await getDb();
		const tx = db.transaction(STORE, "readonly");
		const index = tx.objectStore(STORE).index(BY_COLLECTION);
		const rows = await promisifyRequest<Row[]>(
			index.getAll(IDBKeyRange.only(collection)),
		);
		await transactionDone(tx);
		return rows;
	};

	const rowKey = (collection: string, key: string): string =>
		`${NAMESPACE}${collection}${SEPARATOR}${key}`;

	return {
		async readAll(collection) {
			const rows = await rowsOf(NAMESPACE + collection);
			const prefix = rowKey(collection, "");
			const result = new Map<string, StoredEntry>();
			for (const row of rows) {
				if (row.stored !== undefined)
					result.set(row.key.slice(prefix.length), row.stored);
			}
			return result;
		},

		async merge(collection, changes) {
			const db = await getDb();
			// One readwrite transaction: no other tab can write these keys between the read
			// and the write, so a newer entry stored meanwhile can't be overwritten.
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			const keys = [...changes.keys()];
			const rows = await Promise.all(
				keys.map((key) =>
					promisifyRequest<Row | undefined>(store.get(rowKey(collection, key))),
				),
			);
			const result = new Map<string, StoredEntry>();
			keys.forEach((key, i) => {
				const stored = mergeStored(
					rows[i]?.stored,
					changes.get(key) as StoredEntry,
				);
				result.set(key, stored);
				const row: Row = {
					key: rowKey(collection, key),
					collection: NAMESPACE + collection,
					stored,
				};
				store.put(row);
			});
			await transactionDone(tx);
			return result;
		},

		async remove(collection, keys) {
			if (keys.length === 0) return;
			const db = await getDb();
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			for (const key of keys) store.delete(rowKey(collection, key));
			await transactionDone(tx);
		},

		async readLegacy(collection) {
			const rows = await rowsOf(collection);
			return rows.flatMap((row) => ("record" in row ? [row.record] : []));
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
