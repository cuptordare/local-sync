/**
 * Retry with exponential backoff (+ jitter) for flaky network calls.
 */
export interface RetryOptions {
	/** Total attempts including the first. Default 5. */
	maxAttempts?: number;
	/** Delay before the 2nd attempt. Default 200ms. */
	baseDelayMs?: number;
	/** Upper bound on any single delay. Default 30000ms. */
	maxDelayMs?: number;
	/** Multiplier applied each attempt. Default 2. */
	factor?: number;
	/** Add randomness to avoid thundering-herd retries. Default true. */
	jitter?: boolean;
}

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export function computeBackoff(
	attempt: number,
	options: RetryOptions = {},
): number {
	const base = options.baseDelayMs ?? 200;
	const factor = options.factor ?? 2;
	const max = options.maxDelayMs ?? 30_000;
	const raw = Math.min(max, base * factor ** (attempt - 1));
	const jitter = options.jitter ?? true;
	if (jitter) {
		// "Equal jitter": half fixed, half random -- bounded within [raw/2, raw]. See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
		return raw / 2 + Math.random() * (raw / 2);
	}
	return raw;
}

export async function withRetry<R>(
	fn: () => Promise<R>,
	options: RetryOptions = {},
	sleep: Sleep = defaultSleep,
): Promise<R> {
	const maxAttempts = options.maxAttempts ?? 5;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (attempt >= maxAttempts) break;
			await sleep(computeBackoff(attempt, options));
		}
	}
	throw lastError;
}
