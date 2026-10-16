/**
 * The default 3-way merge for two edits of one value: `mine` and `theirs`, both made from
 * `base` (undefined if both created the value). Changes on both sides are kept:
 *
 *   - only one side changed something: that side's version.
 *   - objects: merged field by field (recursively). A field one side removed, and the other
 *     didn't change, is removed.
 *   - lists of strings/numbers/booleans: merged as sets. Items either side added are kept,
 *     items either side removed are dropped (mine's order first, then theirs' new items).
 *   - lists of objects that all have an `id`: merged item by item, by id. An item one side
 *     removed and the other didn't change is dropped; one the other side changed is kept.
 *   - anything else both sides changed (the same field, set two ways): the later edit wins.
 *
 * Used when a device finds that its unsaved edit and someone else's saved edit both changed a
 * key (see collections/create-collection.ts); the result is saved as a new write.
 */
import { deepEqual } from "../utils/deep-equal.js";

/** Context for a merge. `mineIsLater`: whether this device's edit is the later one. */
export interface MergeContext {
	key: string;
	mineIsLater: boolean;
}

/** Combines two edits of one value made from `base`. */
export type MergeFunction<T> = (
	base: T | undefined,
	mine: T,
	theirs: T,
	context: MergeContext,
) => T;

const ABSENT = Symbol("absent");
type Value = unknown;

const isPlainObject = (v: Value): v is Record<string, Value> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: Value): boolean =>
	v === null || ["string", "number", "boolean"].includes(typeof v);
const idOf = (v: Value): string | number | undefined => {
	const id = isPlainObject(v) ? v.id : undefined;
	return typeof id === "string" || typeof id === "number" ? id : undefined;
};
const allHaveIds = (list: readonly Value[]): boolean =>
	list.every((v) => idOf(v) !== undefined) &&
	new Set(list.map(idOf)).size === list.length;

function merge3(
	base: Value,
	mine: Value,
	theirs: Value,
	mineIsLater: boolean,
): Value {
	if (deepEqual(mine, theirs)) return mine;
	if (deepEqual(base, mine)) return theirs;
	if (deepEqual(base, theirs)) return mine;
	// Removed on one side, changed on the other: keep the change.
	if (mine === ABSENT) return theirs;
	if (theirs === ABSENT) return mine;
	const later = mineIsLater ? mine : theirs;

	if (isPlainObject(mine) && isPlainObject(theirs)) {
		const b = isPlainObject(base) ? base : {};
		const result: Record<string, Value> = {};
		for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
			const merged = merge3(
				Object.hasOwn(b, key) ? b[key] : ABSENT,
				Object.hasOwn(mine, key) ? mine[key] : ABSENT,
				Object.hasOwn(theirs, key) ? theirs[key] : ABSENT,
				mineIsLater,
			);
			if (merged !== ABSENT) result[key] = merged;
		}
		return result;
	}

	if (Array.isArray(mine) && Array.isArray(theirs)) {
		const b = Array.isArray(base) ? base : [];
		const lists = [b, mine, theirs];
		if (lists.every((l) => l.every(isScalar))) {
			const removed = new Set(
				b.filter((v) => !mine.includes(v) || !theirs.includes(v)),
			);
			const result: Value[] = [];
			for (const v of [...mine, ...theirs]) {
				if (!removed.has(v) && !result.includes(v)) result.push(v);
			}
			return result;
		}
		if (lists.every(allHaveIds)) {
			const byId = (l: readonly Value[]) => new Map(l.map((v) => [idOf(v), v]));
			const [bm, mm, tm] = [byId(b), byId(mine), byId(theirs)];
			const result: Value[] = [];
			const ids = [...mm.keys(), ...[...tm.keys()].filter((id) => !mm.has(id))];
			for (const id of ids) {
				const merged = merge3(
					bm.has(id) ? bm.get(id) : ABSENT,
					mm.has(id) ? mm.get(id) : ABSENT,
					tm.has(id) ? tm.get(id) : ABSENT,
					mineIsLater,
				);
				if (merged !== ABSENT) result.push(merged);
			}
			return result;
		}
	}
	return later;
}

/** The default merge (see the module doc). Pure: never changes its inputs. */
export function mergeValues<T>(
	base: T | undefined,
	mine: T,
	theirs: T,
	context: MergeContext,
): T {
	return merge3(
		base === undefined ? ABSENT : base,
		mine,
		theirs,
		context.mineIsLater,
	) as T;
}
