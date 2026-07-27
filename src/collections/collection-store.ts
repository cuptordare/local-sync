/**
 * CollectionStore is an in-memory store for records of a single collection.
 * It supports basic CRUD operations and allows listeners to subscribe to changes in the collection.
 * This is the live source of truth the reactive queries read from. Mutations land here synchronously,
 * then get mirrored to durable storage. It DOES contain the tombstones for deleted records.
 *
 * Reactive queries wire their subscriptions to the CollectionStore, so that they can react to
 * changes in the collection.
 */
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { RecordEnvelope } from "../records/record-envelope.js";
import type { RecordChange } from "./collection-events.js";

export interface CollectionStore<T> {
	get(id: string): RecordEnvelope<T> | undefined;
	/** All records, including tombstones, in insertion order. */
	getAll(): RecordEnvelope<T>[];
	has(id: string): boolean;
	readonly size: number;
	/** Upsert one record and notify. */
	set(record: RecordEnvelope<T>): void;
	/** Upsert multiple records and notify once. */
	setMany(records: readonly RecordEnvelope<T>[]): void;
	/** Hard-remove one record from memory and notify. Returns whether it existed. */
	remove(id: string): boolean;
	/** Subscribe to change batches. Returns an unsubscribe function. */
	subscribe(listener: Listener<readonly RecordChange<T>[]>): Unsubscribe;
}

export function createCollectionStore<T>(): CollectionStore<T> {
	const records = new Map<string, RecordEnvelope<T>>();
	const listeners = new Set<Listener<readonly RecordChange<T>[]>>();

	const notify = (changes: readonly RecordChange<T>[]) => {
		if (changes.length === 0) return;
		for (const listener of [...listeners]) {
			listener(changes);
		}
	};

	return {
		get: (id: string) => records.get(id),
		getAll: () => [...records.values()],
		has: (id: string) => records.has(id),
		get size() {
			return records.size;
		},
		set(record) {
			records.set(record.id, record);
			notify([{ kind: "set", id: record.id, record }]);
		},
		setMany(recordsToSet) {
			const changes: RecordChange<T>[] = [];
			for (const record of recordsToSet) {
				records.set(record.id, record);
				changes.push({ kind: "set", id: record.id, record });
			}
			notify(changes);
		},
		remove(id) {
			if (!records.delete(id)) return false;
			notify([{ kind: "removed", id }]);
			return true;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
