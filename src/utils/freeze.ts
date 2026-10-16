/**
 * Recursively `Object.freeze` a value in place and return it. Records in a collection are
 * frozen so that mutating a read result throws immediately, instead of silently changing
 * in-memory state that is never versioned, persisted, or synced.
 *
 * Typed arrays / DataViews are left as-is: JavaScript can't freeze them (it throws), so
 * their bytes stay mutable -- a known gap, not a reason to refuse storing them.
 */
export function deepFreeze<T>(value: T): T {
	if (
		typeof value !== "object" ||
		value === null ||
		ArrayBuffer.isView(value) ||
		Object.isFrozen(value)
	) {
		return value;
	}
	Object.freeze(value);
	for (const key of Reflect.ownKeys(value)) {
		deepFreeze((value as Record<PropertyKey, unknown>)[key]);
	}
	return value;
}
