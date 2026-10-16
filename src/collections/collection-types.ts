import type { HybridClock, Stamp } from "../crdt/hlc.js";
import type { Entries, Entry } from "../crdt/lww-map.js";
import type { MergeFunction } from "../crdt/merge-values.js";
import type { Listener, Unsubscribe } from "../events/event-types.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import type { RecordEnvelope } from "../records/record-envelope.js";
import type { Validator } from "../records/record-validation.js";
import type {
	StorageAdapter,
	StoredEntry,
} from "../storage/storage-adapter.js";
import type { CollectionChange } from "./collection-events.js";

/** A query filter: return true to include a record. Receives the data and envelope. */
export type QueryPredicate<T> = (data: T, record: RecordEnvelope<T>) => boolean;

/** Where a background error reported to `onError` came from. */
export interface CollectionErrorInfo {
	/**
	 * `"storage"`: reading or writing the StorageAdapter failed.
	 * `"remote-validation"`: a value that came from elsewhere (the remote, another tab, or
	 * storage) failed the collection's validator. It's kept, so devices still agree, but
	 * reads treat its key as missing until a valid value replaces it.
	 * `"merge"`: combining two concurrent edits failed (the `merge` function threw, or its
	 * result failed the validator). The later of the two edits is kept instead.
	 */
	source: "storage" | "remote-validation" | "merge";
	collection: string;
	/** The record involved, when known. */
	id?: string;
}

export interface InsertOptions {
	/** Provide an explicit id (otherwise one will be generated). */
	id?: string;
}

export interface Collection<T extends object> {
	readonly name: string;
	/** Resolves once loaded from storage. If the last attempt failed, tries again. */
	readonly ready: Promise<void>;
	/** Whether loading from storage has completed. */
	readonly hydrated: boolean;
	/** Load from storage, unless loaded already. A failed load is tried again. */
	load(): Promise<void>;

	// Every write below throws until loading has completed (`await ready` first): until then
	// it couldn't tell whether a record exists, or build on the stored value.

	/** Insert a new record and return its id. Throws if a record already exists at `options.id`. */
	insert(data: T, options?: InsertOptions): string;
	/** Shallow-merge a partial patch into an existing record. Throws if missing. */
	update(id: string, data: Partial<T>): void;
	/** Replace an existing record's data entirely. Throws if missing. */
	replace(id: string, data: T): void;
	/** Insert or replace by id (also restores a deleted record). No-op if unchanged. */
	upsert(id: string, data: T): void;
	/** Delete a record. No-op if it is already deleted or doesn't exist. */
	delete(id: string): void;

	/** One-shot, non-reactive read. Undefined if the record is missing or deleted. */
	peek(id: string): RecordEnvelope<T> | undefined;
	/** Live single-record query (shared per id). Undefined if missing or deleted. */
	get(id: string): ReactiveQuery<RecordEnvelope<T> | undefined>;
	/** Live multi-record query. Excludes deleted records. Optional predicate filters. */
	query(predicate?: QueryPredicate<T>): ReactiveQuery<RecordEnvelope<T>[]>;

	/** Observe changes to the collection. */
	subscribe(listener: Listener<CollectionChange<T>>): Unsubscribe;
	/** Dispose of the collection and release resources. */
	dispose(): void;
	/**
	 * Resolves once every change made so far has been written to storage (failures are
	 * reported to `onError`; this never rejects). `app.close()` waits for it.
	 */
	whenPersisted(): Promise<void>;

	// --- Sync integration (used by the sync engine and the source recipe) ---

	/** Keys with writes the remote isn't known to hold yet (deletes included). */
	pending(): string[];
	/** Every entry, deletes included. */
	snapshot(): Map<string, Entry<T>>;
	/**
	 * Merge entries from the remote (newer ones win; values aren't validated per write, but
	 * invalid ones are reported and hidden). `synced`: the remote holds these entries, so
	 * local writes they include are no longer pending.
	 */
	mergeRemote(entries: Entries<T>, options?: { synced?: boolean }): void;
	/** Take in changes another tab already stored (they're merged, not written again). */
	mergeFromTab(
		changes: ReadonlyMap<string, StoredEntry>,
		removed: readonly string[],
	): void;
	/**
	 * Make the collection hold exactly `values` (a read-only source's full snapshot): changed
	 * values are written, unchanged ones keep their entry, and other keys are removed outright.
	 * Invalid values are reported and skipped (the stored copy, if any, stays).
	 */
	replaceAll(values: ReadonlyMap<string, unknown>): void;
	/**
	 * Remove keys the remote no longer has, whose entry here is older than `before` and
	 * isn't pending: the remote dropped them as deletes old enough to forget (see the sync
	 * engine). Returns the removed keys.
	 */
	prune(remote: Entries<T>, before: Stamp): string[];
}

export interface CreateCollectionOptions<T extends object> {
	/** Collection name; also the storage namespace. */
	name: string;
	/** Where entries are persisted. */
	storage: StorageAdapter;
	/** Validation for local writes (which throw) and incoming values (reported, hidden). */
	validator?: Validator<T>;
	/** The clock writes are stamped with. Share one per tab across collections. */
	clock?: HybridClock;
	/** The id this tab writes as (see device-id.ts). Defaults to one loaded from `storage`. */
	writerId?: () => Promise<string>;
	/**
	 * How to combine an unsaved edit here with an edit someone else saved meanwhile (both made
	 * from `base`). The result is saved as a new write. Default: `mergeValues` (objects
	 * field by field, lists as sets or by `id`; the later edit wins where both changed the
	 * same thing). Not called when either side is a delete.
	 */
	merge?: MergeFunction<T>;
	/** Called after such a merge, e.g. to tell the user their edit was combined with another. */
	onMerge?: (merge: { key: string; mine: T; theirs: T; result: T }) => void;
	/** Import records an older version of the library stored (if any). Default true. */
	importLegacy?: boolean;
	/** Called with background errors. Defaults to `console.error`. */
	onError?: (error: unknown, info: CollectionErrorInfo) => void;
	/**
	 * Called after changes have been stored, with the stored entries and the removed keys.
	 * The app uses it to pass them to other tabs (`mergeFromTab`).
	 */
	onPersist?: (
		changes: ReadonlyMap<string, StoredEntry>,
		removed: readonly string[],
	) => void;
}
