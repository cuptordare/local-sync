/**
 * Create a unique id (RFC 4122) with an optional human-readable prefix for debugging purposes.
 * @param prefix The prefix to prepend to the id.
 * @returns A unique id string.
 */
export function createId(prefix?: string): string {
	const uuid = crypto.randomUUID();
	return prefix === undefined ? uuid : `${prefix}_${uuid}`;
}
