/**
 * Events related to changes in collections. A single mutation emits one `CollectionChange`
 * event, carrying a batch of `RecordChange` events for each record that was affected by the mutation.
 */
import type { RecordEnvelope } from "../records/record-envelope.js";

/**
 * `"set"`: the key has a value (`record`). `"deleted"`: it was deleted (a tombstone is kept,
 * so other devices learn of the delete). `"removed"`: it's gone entirely, or its value is
 * hidden because it failed the validator.
 */
export type RecordChangeKind = "set" | "deleted" | "removed";

export interface RecordChange<T> {
	kind: RecordChangeKind;
	id: string;
	/** The current record (present if `kind` is `"set"`). */
	record?: RecordEnvelope<T>;
}

export interface CollectionChange<T> {
	collection: string;
	changes: readonly RecordChange<T>[];
}
