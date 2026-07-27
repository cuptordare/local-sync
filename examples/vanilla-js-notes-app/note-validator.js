import { invalid, valid } from "@localsync";

export const MAX_NOTE_LENGTH = 500;

// A real Validator<Note>: write-time validation that rejects bad data before it
// ever enters the collection (insert/update throw ValidationError on failure).
export function noteValidator(data) {
	if (typeof data !== "object" || data === null) {
		return invalid("Note must be an object");
	}
	const text = /** @type {{ text?: unknown }} */ (data).text;
	if (typeof text !== "string") {
		return invalid([{ path: "text", message: "text must be a string" }]);
	}
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return invalid([{ path: "text", message: "Note text cannot be empty" }]);
	}
	if (trimmed.length > MAX_NOTE_LENGTH) {
		return invalid([
			{
				path: "text",
				message: `Note text must be ${MAX_NOTE_LENGTH} characters or fewer`,
			},
		]);
	}
	return valid({ text: trimmed });
}
