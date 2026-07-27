export interface Debounced<Args extends unknown[]> {
	(...args: Args): void;
	/** Cancel any pending invocation and discard the buffered arguments. */
	cancel(): void;
	/** Invoke immediately with the buffered arguments if a call is pending. */
	flush(): void;
	/** Whether an invocation is currently scheduled. */
	readonly pending: boolean;
}

export function debounce<Args extends unknown[]>(
	fn: (...args: Args) => void,
	waitMs: number,
): Debounced<Args> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let buffered: Args | undefined;

	const run = (): void => {
		timer = undefined;
		const args = buffered;
		buffered = undefined;
		if (args !== undefined) fn(...args);
	};

	const debounced = ((...args: Args): void => {
		buffered = args;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(run, waitMs);
	}) as Debounced<Args>;

	debounced.cancel = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		buffered = undefined;
	};

	debounced.flush = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			run();
		}
	};

	Object.defineProperty(debounced, "pending", {
		get: (): boolean => timer !== undefined,
	});

	return debounced;
}
