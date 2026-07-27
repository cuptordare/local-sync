/**
 * Public exports are added here.
 */

export type { LocalSyncAppEventMap } from "./app/app-events.js";
export type {
	CollectionConfig,
	CreateLocalSyncAppOptions,
	LocalSyncApp,
} from "./app/create-local-sync-app.js";
// App runtime -- the single entry point that wires everything together.
export { createLocalSyncApp } from "./app/create-local-sync-app.js";
export type {
	CollectionChange,
	RecordChange,
	RecordChangeKind,
} from "./collections/collection-events.js";
export type {
	ApplyRemoteOptions,
	Collection,
	CreateCollectionOptions,
	InsertOptions,
	MutateOptions,
	QueryPredicate,
} from "./collections/collection-types.js";
// Collections -- the primary public API: optimistic mutations + live queries.
export { createCollection } from "./collections/create-collection.js";
// Shared, framework-neutral types that public APIs build on.
export type { EventMap, Listener, Unsubscribe } from "./events/event-types.js";
export type {
	InMemoryChannelHub,
	MultiTabSync,
	MultiTabSyncOptions,
	TabChannel,
} from "./network/multi-tab-sync.js";
export {
	createBroadcastChannelTab,
	createInMemoryChannelHub,
	createMultiTabSync,
} from "./network/multi-tab-sync.js";
export type {
	NetworkStatus,
	NetworkStatusOptions,
} from "./network/network-status.js";
// Network awareness + cross-tab coordination.
export { createNetworkStatus } from "./network/network-status.js";
export type {
	ReactiveQuery,
	ReactiveQueryOptions,
} from "./reactivity/reactive-query.js";
// Reactivity -- the public subscription contract.
export { createReactiveQuery } from "./reactivity/reactive-query.js";
// Records -- the data model (envelope) and pluggable conflict resolution.
export type {
	RecordEnvelope,
	RecordMeta,
	RecordSource,
} from "./records/record-envelope.js";
export {
	createEnvelope,
	deleteEnvelope,
	isTombstone,
	markDirty,
	markSynced,
	patchEnvelope,
	updateEnvelope,
} from "./records/record-envelope.js";
export type { MergeFactory, MergeStrategy } from "./records/record-merge.js";
export {
	custom,
	lastWriteWins,
	preferDeletion,
	serverWins,
} from "./records/record-merge.js";
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
// Storage -- the persistence contract, two built-in adapters, and the coordinator.
export type {
	StorageAdapter,
	StoredRecord,
} from "./storage/storage-adapter.js";
export type { StorageEngine } from "./storage/storage-engine.js";
export { createStorageEngine } from "./storage/storage-engine.js";
export type { CreateSyncEngineOptions } from "./sync/create-sync-engine.js";
// Sync -- remote synchronization (adapter contract, engine, status, events, retries).
export { createSyncEngine } from "./sync/create-sync-engine.js";
export type {
	Mutation,
	PullArgs,
	PullResult,
	PushResult,
	SyncAdapter,
} from "./sync/sync-adapter.js";
export type { SyncEngine, SyncStartOptions } from "./sync/sync-engine.js";
export type { SyncDirection, SyncEventMap } from "./sync/sync-events.js";
export type { RetryOptions, Sleep } from "./sync/sync-retries.js";
export { computeBackoff, withRetry } from "./sync/sync-retries.js";
export type { SyncPhase, SyncState, SyncStatus } from "./sync/sync-status.js";
export { createSyncStatus } from "./sync/sync-status.js";
export type { Disposable } from "./utils/disposable.js";
