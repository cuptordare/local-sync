/**
 * A SyncAdapter for "one JSON document per collection" backends: a Google Sheets cell behind
 * an Apps Script, a gist, an S3 object, a KV store entry... You supply `read` and `write` for
 * the whole document; this adapter defines its format and checks what comes back. The sync
 * engine does the merging, so every save keeps other devices' entries.
 *
 * The document is `{ format: "lww-1", entries: { [key]: { value, deleted, stamp, device } } }`
 * (see crdt/lww-map.ts). Deletes stay in it as entries with `deleted: true`, so other devices
 * learn about them.
 *
 * If `read` returns an `etag` and `write` honors `ifMatch`, two devices saving at the same
 * moment can't overwrite each other: the second write is refused, and that device reads,
 * merges and tries again.
 *
 * `legacy`: the document an older version of this library saved (`{ records: [...] }`). While
 * the new document is empty, its records are imported (see migration/legacy.ts) and saved
 * into the new document with the next push. Keep the two apart: an older app version reading
 * a document in the new format would see no records, and save over it.
 *
 * @example
 *   const remote = createBlobSyncAdapter<Todo>({
 *     read: () => api.get("todos:lww"),                                   // -> { format, entries, etag? } | null
 *     write: (blob, { ifMatch }) => api.set("todos:lww", blob, ifMatch),  // -> void | { conflict: true }
 *     legacy: { read: () => api.get("todos") },                           // optional
 *   });
 */
import type { Entry } from "../../crdt/lww-map.js";
import { isEntry } from "../../crdt/lww-map.js";
import {
	fromLegacyRecords,
	legacyBlobRecords,
} from "../../migration/legacy.js";
import type { RemoteState, SyncAdapter } from "../sync-adapter.js";

export const BLOB_FORMAT = "lww-1";

/** The document saved for a collection. */
export interface LwwBlob<T> {
	format: typeof BLOB_FORMAT;
	entries: Record<string, Entry<T>>;
}

/** What `read` returns: the saved document, plus its etag if the backend has one. */
export interface BlobSnapshot<T> {
	format?: typeof BLOB_FORMAT;
	entries?: Record<string, Entry<T>>;
	/** An opaque version of the whole document, for compare-and-swap writes (optional). */
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
	 * Read the whole document. Return `null`/`undefined` if it doesn't exist yet. Throw on any
	 * failure (e.g. a non-OK HTTP response) -- never return an empty document for a failed
	 * read. If your backend supports etags, return one even for a missing document (e.g.
	 * `{ etag: "0" }`), so the first write can be checked too.
	 */
	read(): Promise<BlobSnapshot<T> | null | undefined>;
	/** Replace the whole document. Return `{ conflict: true }` if an `ifMatch` precondition failed. */
	write(blob: LwwBlob<T>, options: BlobWriteOptions): Promise<BlobWriteResult>;
	/**
	 * Where an older version of the library saved this collection (`{ records: [...] }`), to
	 * import while the new document is empty. It's only read, never written.
	 */
	legacy?: { read(): Promise<unknown> };
}

const describe = (value: unknown): string =>
	(JSON.stringify(value) ?? String(value)).slice(0, 200);

function parse<T>(raw: BlobSnapshot<T> | null | undefined): {
	entries: Map<string, Entry<T>>;
	etag?: string;
} {
	if (raw === null || raw === undefined) return { entries: new Map() };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Blob read returned an unexpected shape: ${describe(raw)}`);
	}
	const etag = typeof raw.etag === "string" ? raw.etag : undefined;
	const withEtag = <R extends object>(result: R) =>
		etag === undefined ? result : { ...result, etag };
	if (raw.format === undefined && "records" in raw) {
		throw new Error(
			"Blob read returned a document in the old { records } format. Save the new format " +
				"under a new name, and pass the old one's reader as `legacy` to import it.",
		);
	}
	if (raw.format !== undefined && raw.format !== BLOB_FORMAT) {
		throw new Error(
			`Blob read returned format ${describe(raw.format)}, but this version of the ` +
				`library reads "${BLOB_FORMAT}" (was it saved by a newer version?)`,
		);
	}
	if (raw.entries === undefined) return withEtag({ entries: new Map() });
	if (typeof raw.entries !== "object" || raw.entries === null) {
		throw new Error(`Blob read returned an unexpected shape: ${describe(raw)}`);
	}
	const entries = new Map<string, Entry<T>>();
	for (const [key, entry] of Object.entries(raw.entries)) {
		// e.g. an `{ error: "..." }` body from a failing backend -- never treat that as data.
		if (!isEntry(entry)) {
			throw new Error(
				`Blob read returned a malformed entry for "${key}": ${describe(entry)}`,
			);
		}
		entries.set(key, entry as Entry<T>);
	}
	return withEtag({ entries });
}

export function createBlobSyncAdapter<T>(
	options: BlobSyncAdapterOptions<T>,
): Required<SyncAdapter<T>> {
	return {
		async read(): Promise<RemoteState<T>> {
			const state: RemoteState<T> = parse(await options.read());
			if (state.entries.size > 0 || options.legacy === undefined) return state;
			const old = await options.legacy.read();
			if (old === null || old === undefined) return state;
			const records = legacyBlobRecords(old);
			if (records === undefined) {
				throw new Error(
					`Legacy blob read returned an unexpected shape: ${describe(old)}`,
				);
			}
			return {
				...state,
				imported: fromLegacyRecords(records) as Map<string, Entry<T>>,
			};
		},

		async write(entries, { ifMatch }) {
			return options.write(
				{ format: BLOB_FORMAT, entries: Object.fromEntries(entries) },
				ifMatch === undefined ? {} : { ifMatch },
			);
		},
	};
}
