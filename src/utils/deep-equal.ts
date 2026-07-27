export function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;

	if (
		typeof a !== "object" ||
		a === null ||
		typeof b !== "object" ||
		b === null
	) {
		return false;
	}

	if (a instanceof Date && b instanceof Date) {
		return (
			a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
		);
	}

	const aIsArray = Array.isArray(a);
	const bIsArray = Array.isArray(b);
	if (aIsArray !== bIsArray) return false;

	if (aIsArray && bIsArray) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}

	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const aKeys = Object.keys(aObj);
	const bKeys = Object.keys(bObj);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(bObj, key)) return false;
		if (!deepEqual(aObj[key], bObj[key])) return false;
	}

	return true;
}
