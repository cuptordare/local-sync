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
import type { NetworkStatus } from "../network/network-status.js";
import type { ReactiveQuery } from "../reactivity/reactive-query.js";
import { createReactiveQuery } from "../reactivity/reactive-query.js";
import { createEngine } from "../sync/create-sync-engine.js";
import type { SyncEngine } from "../sync/sync-engine.js";
import type { RetryOptions, Sleep } from "../sync/sync-retries.js";
import { withRetry } from "../sync/sync-retries.js";
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

/** Hard stop for a paginated fetch, so a misbehaving `fetchPage` can't loop forever. */
const MAX_PAGES = 1000;

export interface SourceEngineOptions<T, Filter, Cursor>
	extends SourceAdapterOptions<T, Filter, Cursor> {
	filter?: Filter;
	retry?: RetryOptions;
	/** Injectable sleep for retries (tests pass a no-op). */
	sleep?: Sleep;
	network?: NetworkStatus;
	now?: () => number;
}

/**
 * The engine that keeps a source's collection up to date: each pull fetches every page and
 * makes the collection hold exactly those items (`replaceAll`), so items that disappeared at
 * the source disappear locally too, and unchanged ones keep their entry (no write, no
 * re-render). Nothing is changed unless every page succeeds.
 */
export function createSourceEngine<T extends object, Filter, Cursor>(
	name: string,
	collection: Collection<T>,
	options: SourceEngineOptions<T, Filter, Cursor>,
): SyncEngine<Filter> {
	let filter = options.filter;
	let generation = 0;

	const fetchAll = async (): Promise<Map<string, T> | undefined> => {
		const started = generation;
		const items = new Map<string, T>();
		let cursor: Cursor | undefined;
		for (let page = 1; ; page++) {
			const args = { filter, cursor };
			const result = await withRetry(
				() => options.fetchPage(args),
				options.retry ?? {},
				options.sleep,
			);
			// The filter changed while this page was loading: these results are for the old
			// filter, so drop them (setFilter queued a fresh pull for the new one).
			if (started !== generation) return undefined;
			if (
				result === null ||
				typeof result !== "object" ||
				!Array.isArray(result.items)
			) {
				throw new Error(
					`fetchPage for source "${name}" must return { items: [...], nextCursor? }`,
				);
			}
			for (const item of result.items) items.set(idOf(item), item);
			if (result.nextCursor === undefined) return items;
			if (deepEqual(result.nextCursor, cursor)) {
				throw new Error(
					`fetchPage for source "${name}" returned the same nextCursor twice; stopping ` +
						"to avoid an endless loop. Omit nextCursor on the last page.",
				);
			}
			if (page >= MAX_PAGES) {
				throw new Error(
					`fetchPage for source "${name}" returned more than ${MAX_PAGES} pages; stopping.`,
				);
			}
			cursor = result.nextCursor;
		}
	};

	const idOf = (item: T): string => {
		const rawId = options.getId(item);
		if (
			(typeof rawId !== "string" && typeof rawId !== "number") ||
			rawId === ""
		) {
			throw new Error(
				`getId for source "${name}" returned ${JSON.stringify(rawId)}; it must return a non-empty string or number`,
			);
		}
		return String(rawId);
	};

	return createEngine<Filter>({
		...(options.network !== undefined ? { network: options.network } : {}),
		...(options.now !== undefined ? { now: options.now } : {}),
		load: () => collection.load(),
		async pull() {
			const items = await fetchAll();
			if (items === undefined) return false;
			collection.replaceAll(items);
			return true;
		},
		pendingCount: () => 0,
		watch: () => () => {},
		setFilter(next) {
			filter = next as Filter;
			generation += 1;
		},
	});
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
		"mergeRemote",
		"mergeFromTab",
		"replaceAll",
		"prune",
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
