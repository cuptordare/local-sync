/**
 * Public exports are added here.
 */

export type {
	LocalSyncAppEventMap,
	LocalSyncErrorEvent,
	LocalSyncMergeEvent,
} from "./app/app-events.js";
export type { MultiTabOptions, TabLocks } from "./app/app-multi-tab.js";
export type { AppSyncState, AppSyncStatus } from "./app/app-status.js";
export type {
	CollectionConfig,
	CreateLocalSyncAppOptions,
	KeyValueOptions,
	LocalSyncApp,
	ManagedSyncOptions,
	SourceOptions,
} from "./app/create-local-sync-app.js";
// App runtime -- the single entry point that wires everything together, including the two
// recipes: app.keyValue() (simple named values) and app.source() (read-only outside data).
export { createLocalSyncApp } from "./app/create-local-sync-app.js";
export type { KeyValueStore, WatchOptions } from "./app/key-value-store.js";
export type {
	ReadonlyCollection,
	Source,
	SourceFetchArgs,
	SourcePage,
} from "./app/source.js";
export type {
	CollectionChange,
	RecordChange,
	RecordChangeKind,
} from "./collections/collection-events.js";
export type {
	Collection,
	CollectionErrorInfo,
	CreateCollectionOptions,
	InsertOptions,
	QueryPredicate,
} from "./collections/collection-types.js";
// Collections -- the record API: local writes + live queries.
export { createCollection } from "./collections/create-collection.js";
// The data model: a last-writer-wins map ordered by a hybrid logical clock.
export type { HybridClock, Stamp } from "./crdt/hlc.js";
export { createHybridClock, stampAt, stampTime } from "./crdt/hlc.js";
export type { Entries, Entry, Mark } from "./crdt/lww-map.js";
export {
	compareEntries,
	mergeEntries,
	newerEntry,
} from "./crdt/lww-map.js";
export type { MergeContext, MergeFunction } from "./crdt/merge-values.js";
export { mergeValues } from "./crdt/merge-values.js";
// Shared, framework-neutral types that public APIs build on.
export type { EventMap, Listener, Unsubscribe } from "./events/event-types.js";
// Importing data stored by earlier versions of the library.
export {
	fromLegacyRecords,
	LEGACY_DEVICE,
} from "./migration/legacy.js";
export type {
	NetworkStatus,
	NetworkStatusOptions,
} from "./network/network-status.js";
// Network awareness + cross-tab transport.
export { createNetworkStatus } from "./network/network-status.js";
export type { InMemoryChannelHub, TabChannel } from "./network/tab-channel.js";
export {
	createBroadcastChannelTab,
	createInMemoryChannelHub,
} from "./network/tab-channel.js";
export type {
	ReactiveQuery,
	ReactiveQueryOptions,
} from "./reactivity/reactive-query.js";
// Reactivity -- the public subscription contract.
export { createReactiveQuery } from "./reactivity/reactive-query.js";
export type {
	RecordEnvelope,
	RecordMeta,
} from "./records/record-envelope.js";
export type {
	ValidationIssue,
	ValidationResult,
	Validator,
} from "./records/record-validation.js";
export {
	fromGuard,
	invalid,
	passthrough,
	ValidationError,
	valid,
	validateOrThrow,
} from "./records/record-validation.js";
export type { IndexedDBAdapterOptions } from "./storage/indexeddb-adapter.js";
export { createIndexedDBAdapter } from "./storage/indexeddb-adapter.js";
export { createMemoryAdapter } from "./storage/memory-adapter.js";
// Storage -- the persistence contract and two built-in adapters.
export type {
	StorageAdapter,
	StoredEntry,
} from "./storage/storage-adapter.js";
export { mergeStored } from "./storage/storage-adapter.js";
export type {
	BlobSnapshot,
	BlobSyncAdapterOptions,
	BlobWriteOptions,
	BlobWriteResult,
	LwwBlob,
} from "./sync/adapters/blob-sync-adapter.js";
// Ready-made adapter for "one JSON blob per collection" backends (Sheets/Apps Script, gist, S3...).
export {
	BLOB_FORMAT,
	createBlobSyncAdapter,
} from "./sync/adapters/blob-sync-adapter.js";
export type { CreateSyncEngineOptions } from "./sync/create-sync-engine.js";
// Sync -- remote synchronization (adapter contract, engine, status, events, retries).
export { createSyncEngine } from "./sync/create-sync-engine.js";
export type {
	RemoteState,
	SyncAdapter,
	WriteOptions,
	WriteResult,
} from "./sync/sync-adapter.js";
export type {
	PushOnChangeOptions,
	SyncEngine,
	SyncStartOptions,
} from "./sync/sync-engine.js";
export type { SyncDirection, SyncEventMap } from "./sync/sync-events.js";
export type { RetryOptions, Sleep } from "./sync/sync-retries.js";
export { computeBackoff, withRetry } from "./sync/sync-retries.js";
export type { SyncPhase, SyncState, SyncStatus } from "./sync/sync-status.js";
export { createSyncStatus } from "./sync/sync-status.js";
export type { Disposable } from "./utils/disposable.js";
