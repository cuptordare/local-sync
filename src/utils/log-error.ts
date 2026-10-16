/** Where a background error came from, as reported to `onError` handlers. */
export interface ErrorOrigin {
	source: string;
	collection: string;
	id?: string;
}

/** The fallback for a background error nobody handles: log it, naming where it came from. */
export function logBackgroundError(error: unknown, origin: ErrorOrigin): void {
	const where =
		origin.id === undefined
			? `collection "${origin.collection}"`
			: `record "${origin.id}" in collection "${origin.collection}"`;
	console.error(`[localsync] ${origin.source} error for ${where}:`, error);
}
