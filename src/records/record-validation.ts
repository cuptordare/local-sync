/**
 * WHAT THIS IS — record-validation (bring-your-own validator)
 *
 * @example
 *   const validator: Validator<Todo> = (data) => {
 *     const r = todoSchema.safeParse(data);
 *     return r.success ? valid(r.data) : invalid(r.error.issues.map((i) => i.message));
 *   };
 *
 * @example
 *   const isTodo = (d: unknown): d is Todo => {
 *     return typeof d === "object" && d !== null && "title" in d;
 *   };
 *   const validator = fromGuard<Todo>(isTodo, "Not a Todo");
 */

/** A single validation problem. */
export interface ValidationIssue {
	path?: string;
	message: string;
}

export type ValidationResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export type Validator<T> = (data: unknown) => ValidationResult<T>;

export function valid<T>(value: T): ValidationResult<T> {
	return { ok: true, value };
}

export function invalid(
	issues: readonly ValidationIssue[] | string,
): ValidationResult<never> {
	const list = typeof issues === "string" ? [{ message: issues }] : issues;
	return { ok: false, issues: list };
}

/** A validator that always succeeds, returning the input data as-is. The default. */
export function passthrough<T>(): Validator<T> {
	return (data: unknown) => valid(data as T);
}

export function fromGuard<T>(
	guard: (data: unknown) => data is T,
	message = "Validation failed",
): Validator<T> {
	return (data) => (guard(data) ? valid(data) : invalid(message));
}

export class ValidationError extends Error {
	readonly issues: readonly ValidationIssue[];

	constructor(issues: readonly ValidationIssue[]) {
		super(
			issues
				.map((i) =>
					i.path !== undefined ? `${i.path}: ${i.message}` : i.message,
				)
				.join("; "),
		);
		this.name = "ValidationError";
		this.issues = issues;
	}
}

/** Run a validator and throw a ValidationError if it fails. */
export function validateOrThrow<T>(validator: Validator<T>, data: unknown): T {
	const result = validator(data);
	if (result.ok) {
		return result.value;
	} else {
		throw new ValidationError(result.issues);
	}
}
