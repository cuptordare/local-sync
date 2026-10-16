/**
 * A SyncAdapter for "one JSON blob per collection" backends: a Google Sheets cell behind an
 * Apps Script, a gist, an S3 object, a KV store entry... You supply `read` and `write` for
 * the whole blob; this adapter does the careful part:
 *
 *   - Read-modify-write: a push re-reads the blob and replaces only the pushed records, so
 *     other clients' records in the same blob are kept.
 *   - Per-record conflict detection: a push based on an outdated copy of a record (someone
 *     else saved it since) is rejected with the current copy, which the sync engine resolves
 *     through the collection's merge strategy -- instead of silently overwriting their change.
 *   - Optional compare-and-swap: if `read` returns an `etag` and `write` honors `ifMatch`,
 *     two clients writing the blob at the same moment can't erase each other's writes; the
 *     loser re-reads and retries. Without it there remains a small window (between this
 *     adapter's read and write) where a simultaneous write by another client can be lost.
 *
 * The blob format is `{ records: RecordEnvelope[] }`. Deletes are stored as tombstones
 * (`meta.deleted`) so other clients learn about them. Pulls are NOT snapshots: an empty or
 * reset blob never wipes local data.
 *
 * @example
 *   const remote = createBlobSyncAdapter<Todo>({
 *     read: () => api.get("todos"),                               // -> { records, etag? } | null
 *     write: (blob, { ifMatch }) => api.set("todos", blob, ifMatch), // -> void | { conflict: true }
 *   });
 *   const todos = app.keyValue<Todo>("todos", { remote });
 */
import type { RecordEnvelope } from "../../records/record-envelope.js";
import { deepEqual } from "../../utils/deep-equal.js";
import type {
	Mutation,
	PushRejection,
	PushResult,
	SyncAdapter,
} from "../sync-adapter.js";

export interface BlobSnapshot<T> {
	records: RecordEnvelope<T>[];
	/** An opaque version of the whole blob, for compare-and-swap writes (optional). */
	etag?: string;
}

export interface BlobWriteOptions {
	/**
	 * The `etag` from the read this write is based on (only if `read` returned one). If your
	 * backend's current etag differs, don't write -- return `{ conflict: true }`.
	 */
	ifMatch?: string;
}

/** Nothing (written), or `{ conflict: true }` when an `ifMatch` precondition failed. */
// biome-ignore lint/suspicious/noConfusingVoidType: lets a plain `async () => { await ... }` writer type-check
export type BlobWriteResult = void | { conflict: true };

export interface BlobSyncAdapterOptions<T> {
	/**
	 * Read the whole blob. Return `null`/`undefined` if it doesn't exist yet. A bare array of
	 * records is accepted too. Throw on any failure (e.g. a non-OK HTTP response). If your
	 * backend supports etags, return one even for a missing blob (e.g. `{ records: [],
	 * etag: "0" }`) -- with no etag, the first write can't be checked for a concurrent one.
	 */
	read(): Promise<BlobSnapshot<T> | RecordEnvelope<T>[] | null | undefined>;
	/** Replace the whole blob. Return `{ conflict: true }` if an `ifMatch` precondition failed. */
	write(
		blob: { records: RecordEnvelope<T>[] },
		options: BlobWriteOptions,
	): Promise<BlobWriteResult>;
	/** How many times to re-read and retry after a compare-and-swap conflict. Default 3. */
	maxConflictRetries?: number;
}

function isEnvelopeArray(value: unknown): value is RecordEnvelope<unknown>[] {
	return (
		Array.isArray(value) &&
		value.every(
			(r) =>
				typeof r === "object" &&
				r !== null &&
				typeof (r as RecordEnvelope<unknown>).id === "string" &&
				typeof (r as RecordEnvelope<unknown>).meta === "object",
		)
	);
}

/** Store records in the blob as plain remote data (client-only bookkeeping stripped). */
function toBlobRecord<T>(record: RecordEnvelope<T>): RecordEnvelope<T> {
	const { remoteVersion: _client, ...meta } = record.meta;
	return {
		id: record.id,
		data: record.data,
		meta: { ...meta, dirty: false, source: "remote" },
	};
}

/**
 * Whether the remote changed this record since the local edit's base. Records written before
 * `remoteVersion` existed have no base; for those, the edit is accepted only if it is ahead of
 * the remote (the version history the engine always relied on).
 */
function isStale<T>(
	local: RecordEnvelope<T>,
	remote: RecordEnvelope<T>,
): boolean {
	if (
		deepEqual(local.data, remote.data) &&
		local.meta.deleted === remote.meta.deleted
	) {
		return false; // same content: nothing to lose
	}
	const base = local.meta.remoteVersion;
	return base === undefined
		? local.meta.version <= remote.meta.version
		: base !== remote.meta.version;
}

export function createBlobSyncAdapter<T>(
	options: BlobSyncAdapterOptions<T>,
): SyncAdapter<T> {
	const maxConflictRetries = options.maxConflictRetries ?? 3;

	const readBlob = async (): Promise<BlobSnapshot<T>> => {
		const raw = await options.read();
		if (raw === null || raw === undefined) return { records: [] };
		if (isEnvelopeArray(raw)) return { records: raw as RecordEnvelope<T>[] };
		if (
			typeof raw === "object" &&
			isEnvelopeArray((raw as BlobSnapshot<T>).records)
		) {
			return raw as BlobSnapshot<T>;
		}
		// e.g. an `{ error: "..." }` body from a failing backend -- never treat that as data.
		throw new Error(
			`Blob read returned an unexpected shape: ${JSON.stringify(raw).slice(0, 200)}`,
		);
	};

	return {
		async pull() {
			const { records } = await readBlob();
			return { records };
		},

		async push(mutations: Mutation<T>[]): Promise<PushResult<T>> {
			for (let attempt = 0; ; attempt++) {
				const { records, etag } = await readBlob();
				const current = new Map(records.map((r) => [r.id, r]));
				const acked: string[] = [];
				const rejected: PushRejection<T>[] = [];

				for (const mutation of mutations) {
					const remote = current.get(mutation.recordId);
					if (remote !== undefined && isStale(mutation.record, remote)) {
						rejected.push({
							mutationId: mutation.mutationId,
							reason:
								"The record was changed by someone else since it was last synced",
							record: remote,
						});
						continue;
					}
					current.set(mutation.recordId, toBlobRecord(mutation.record));
					acked.push(mutation.mutationId);
				}

				if (acked.length === 0) return { acked, rejected };
				const result = await options.write(
					{ records: [...current.values()] },
					etag === undefined ? {} : { ifMatch: etag },
				);
				if (result?.conflict !== true) return { acked, rejected };
				if (attempt >= maxConflictRetries) {
					throw new Error(
						`Blob write kept conflicting after ${maxConflictRetries + 1} attempts (it is being changed concurrently)`,
					);
				}
			}
		},
	};
}
