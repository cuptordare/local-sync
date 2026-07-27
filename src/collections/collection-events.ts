/**
 * Events related to changes in collections. A single mutation emits one `CollectionChange`
 * event, carrying a batch of `RecordChange` events for each record that was affected by the mutation.
 */
import type { RecordEnvelope } from "../records/record-envelope.js";

export type RecordChangeKind = "set" | "removed";

export interface RecordChange<T> {
	/** `"set"` = upserted (insert/update/delete-tombstone). `"removed"` = purged from memory. */
	kind: RecordChangeKind;
	id: string;
	/** The new record (present if `kind` is `"set"`). */
	record?: RecordEnvelope<T>;
}

export interface CollectionChange<T> {
	collection: string;
	changes: readonly RecordChange<T>[];
}
