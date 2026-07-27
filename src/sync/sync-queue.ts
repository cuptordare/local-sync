/**
 * Turns the pending (dirty) records into the wire `Mutation`s for one push.
 *
 * There is intentionally NO separate durable queue. A record's `meta.dirty` flat IS
 * the push backlog, and it persists in storage -- so a change made while offline is
 * still "pending" after a reload, with no extra bookkeeping to keep in sync. The dirty
 * set is the single source of truth; the helper just shapes it for an adapter.
 */
import type { RecordEnvelope } from "../records/record-envelope.js";
import { createId } from "../utils/ids.js";
import type { Mutation } from "./sync-adapter.js";

export function buildMutations<T>(
	collection: string,
	records: readonly RecordEnvelope<T>[],
): Mutation<T>[] {
	return records.map((record) => ({
		mutationId: createId("mut"),
		collection,
		recordId: record.id,
		record,
	}));
}
