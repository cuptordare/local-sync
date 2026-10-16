/**
 * The "read-only list from an outside service" recipe (Jira, Azure DevOps, GitHub, a calendar...).
 *
 * You describe how to fetch ONE page; the library does the rest: follows pages, caches items
 * locally (offline-readable), refreshes on an interval, and -- because every refresh is a full
 * snapshot -- removes items that disappeared at the source. The local copy is read-only, so it
 * can't drift from the source.
 *
 * @example
 *   const issues = app.source<Issue, { project: string }>("issues", {
 *     fetchPage: async ({ filter, cursor }) => {
 *       const res = await fetch(`/api/issues?project=${filter?.project}&page=${cursor ?? 1}`);
 *       if (!res.ok) throw new Error(`HTTP ${res.status}`); // never return [] on failure!
 *       const body = await res.json();
 *       return { items: body.issues, nextCursor: body.nextPage }; // omit nextCursor on the last page
 *     },
 *     getId: (issue) => issue.key,
 *     filter: { project: "ABC" },
 *     refreshIntervalMs: 5 * 60_000,
 *   });
 *   issues.query((i) => i.status !== "Done").subscribe(render);
 */
import type { Collection } from "../collections/collection-types.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveQuery } from "../reactivity/reactive-query.js";
import type { RecordEnvelope } from "../records/record-envelope.js";
import type { Validator } from "../records/record-validation.js";
import type { SyncAdapter } from "../sync/sync-adapter.js";
import type { SyncEngine } from "../sync/sync-engine.js";
import { deepEqual } from "../utils/deep-equal.js";

export interface SourcePage<T, Cursor = unknown> {
	items: T[];
	/** Where the next page starts. Omit (or undefined) on the last page. */
	nextCursor?: Cursor | undefined;
}

export interface SourceFetchArgs<Filter, Cursor> {
	filter: Filter | undefined;
	/** undefined for the first page. */
	cursor: Cursor | undefined;
}

/** The read side of a Collection -- what a source exposes, so its cache can't be edited locally. */
export type ReadonlyCollection<T extends object> = Pick<
	Collection<T>,
	"name" | "ready" | "hydrated" | "peek" | "get" | "query" | "subscribe"
>;

export interface Source<T extends object, Filter = unknown> {
	readonly name: string;
	/** Resolves once the locally cached items have loaded (they're readable offline). */
	readonly ready: Promise<void>;
	/** One item by id, or undefined. Frozen. */
	peek(id: string): T | undefined;
	/** All cached items. */
	all(): T[];
	/** Live single item. */
	get(id: string): ReactiveQuery<T | undefined>;
	/** Live list of items, optionally filtered locally. */
	query(predicate?: (item: T) => boolean): ReactiveQuery<T[]>;
	/** Change what is fetched and refresh. Items outside the new filter are removed. */
	setFilter(filter: Filter): Promise<void>;
	/** Fetch everything again now. Rejects if the fetch fails (also reported as an app "error"). */
	refresh(): Promise<void>;
	/** The cached records with their metadata (advanced). Read-only. */
	readonly collection: ReadonlyCollection<T>;
	/** The sync engine (advanced: status, events). */
	readonly engine: SyncEngine<Filter>;
}

export interface SourceAdapterOptions<T, Filter, Cursor> {
	/** Fetch one page. Throw on any failure -- returning an empty page would empty the cache. */
	fetchPage(
		args: SourceFetchArgs<Filter, Cursor>,
	): Promise<SourcePage<T, Cursor>>;
	/** A stable, unique id for an item. Numbers are converted to strings. */
	getId(item: T): string | number;
}

/**
 * Wrap a page-fetching function as a pull-only, full-snapshot SyncAdapter. Each item becomes a
 * remote record whose version only moves when the item's content changes, so an unchanged
 * item costs no storage write and wakes no query on refresh.
 */
export function createSourceAdapter<T extends object, Filter, Cursor>(
	name: string,
	/** The cached copy of an item, to keep its version stable while it's unchanged. */
	peek: (id: string) => RecordEnvelope<T> | undefined,
	options: SourceAdapterOptions<T, Filter, Cursor>,
	clock: () => number,
	/** The collection's validator: the cached copy holds its output, so compare against that. */
	validator?: Validator<T>,
): SyncAdapter<T, Filter, Cursor> {
	const asStored = (item: T): unknown => {
		if (validator === undefined) return item;
		const result = validator(structuredClone(item));
		return result.ok ? result.value : item; // invalid: the collection skips and reports it
	};
	return {
		async pull({ filter, cursor }) {
			const page = await options.fetchPage({ filter, cursor });
			if (
				page === null ||
				typeof page !== "object" ||
				!Array.isArray(page.items)
			) {
				throw new Error(
					`fetchPage for source "${name}" must return { items: [...], nextCursor? }`,
				);
			}
			const now = clock();
			const records = page.items.map((item): RecordEnvelope<T> => {
				const rawId = options.getId(item);
				if (
					(typeof rawId !== "string" && typeof rawId !== "number") ||
					rawId === ""
				) {
					throw new Error(
						`getId for source "${name}" returned ${JSON.stringify(rawId)}; it must return a non-empty string or number`,
					);
				}
				const id = String(rawId);
				const existing = peek(id);
				const unchanged =
					existing !== undefined && deepEqual(existing.data, asStored(item));
				return {
					id,
					data: item,
					meta: {
						version: unchanged
							? existing.meta.version
							: (existing?.meta.version ?? 0) + 1,
						createdAt: existing?.meta.createdAt ?? now,
						updatedAt: unchanged ? existing.meta.updatedAt : now,
						deleted: false,
						dirty: false,
						source: "remote",
					},
				};
			});
			const hasMore = page.nextCursor !== undefined;
			return hasMore
				? { records, cursor: page.nextCursor as Cursor, hasMore: true }
				: { records, complete: true };
		},
	};
}

const readOnlyError = (name: string, method: string) => () => {
	throw new Error(
		`"${name}" is a read-only source: ${method}() isn't allowed. Its data comes only from fetchPage.`,
	);
};

/** Expose only the read side of a collection; mutators throw a clear error for JS callers. */
export function toReadonlyCollection<T extends object>(
	collection: Collection<T>,
): ReadonlyCollection<T> {
	const view = {
		name: collection.name,
		get ready() {
			return collection.ready;
		},
		get hydrated() {
			return collection.hydrated;
		},
		peek: collection.peek,
		get: collection.get,
		query: collection.query,
		subscribe: collection.subscribe,
	};
	for (const method of [
		"insert",
		"update",
		"replace",
		"upsert",
		"delete",
		"applyRemote",
		"markSynced",
		"removeUnseen",
		"purgeDeleted",
	]) {
		Object.defineProperty(view, method, {
			value: readOnlyError(collection.name, method),
		});
	}
	return Object.freeze(view);
}

const mapQuery = <A, B>(
	source: ReactiveQuery<A>,
	map: (value: A) => B,
): ReactiveQuery<B> =>
	createReactiveQuery({
		compute: () => map(source.getCurrentResult()),
		subscribeToSources: (onChange) => source.subscribe(() => onChange()),
	});

export function createSource<T extends object, Filter>(
	collection: ReadonlyCollection<T>,
	engine: SyncEngine<Filter>,
	/** Called when the filter changes (the app shares it with other tabs). */
	onFilterChange?: (filter: Filter) => void,
): Source<T, Filter> {
	return {
		name: collection.name,
		get ready() {
			return collection.ready;
		},
		peek: (id) => collection.peek(id)?.data,
		all: () =>
			collection
				.query()
				.getCurrentResult()
				.map((record) => record.data),
		get: (id) => mapQuery(collection.get(id), (record) => record?.data),
		query: (predicate) =>
			mapQuery(
				collection.query(
					predicate === undefined ? undefined : (data) => predicate(data),
				),
				(records) => records.map((record) => record.data),
			),
		async setFilter(filter) {
			engine.setFilter(filter);
			onFilterChange?.(filter);
			await engine.pull();
		},
		refresh: () => engine.pull(),
		collection,
		engine,
	};
}
