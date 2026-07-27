import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReactiveCache } from "../../../src/reactivity/reactive-cache.js";
import { createReactiveQuery } from "../../../src/reactivity/reactive-query.js";

describe("createReactiveCache", () => {
	it("returns the same instance for repeated get() calls with the same key", () => {
		const cache = createReactiveCache();
		let factoryCalls = 0;
		const factory = () => {
			factoryCalls += 1;
			return createReactiveQuery({ compute: () => 1 });
		};
		const a = cache.get("k", factory);
		const b = cache.get("k", factory);
		assert.equal(a, b);
		assert.equal(factoryCalls, 1);
	});

	it("different keys get different instances", () => {
		const cache = createReactiveCache();
		const a = cache.get("a", () => createReactiveQuery({ compute: () => 1 }));
		const b = cache.get("b", () => createReactiveQuery({ compute: () => 2 }));
		assert.notEqual(a, b);
	});

	it("has() reflects presence", () => {
		const cache = createReactiveCache();
		assert.equal(cache.has("k"), false);
		cache.get("k", () => createReactiveQuery({ compute: () => 1 }));
		assert.equal(cache.has("k"), true);
	});

	it("delete() disposes and removes the entry, returning whether one existed", () => {
		const cache = createReactiveCache();
		let disposed = false;
		cache.get("k", () => {
			const q = createReactiveQuery({ compute: () => 1 });
			const originalDispose = q.dispose;
			q.dispose = () => {
				disposed = true;
				originalDispose();
			};
			return q;
		});
		assert.equal(cache.delete("k"), true);
		assert.equal(disposed, true);
		assert.equal(cache.has("k"), false);
		assert.equal(cache.delete("k"), false);
	});

	it("clear() disposes all entries", () => {
		const cache = createReactiveCache();
		const disposedKeys: string[] = [];
		for (const key of ["a", "b", "c"]) {
			cache.get(key, () => {
				const q = createReactiveQuery({ compute: () => 1 });
				const originalDispose = q.dispose;
				q.dispose = () => {
					disposedKeys.push(key);
					originalDispose();
				};
				return q;
			});
		}
		cache.clear();
		assert.deepEqual(disposedKeys.sort(), ["a", "b", "c"]);
		assert.equal(cache.size, 0);
	});

	it("size reflects the number of cached entries", () => {
		const cache = createReactiveCache();
		assert.equal(cache.size, 0);
		cache.get("a", () => createReactiveQuery({ compute: () => 1 }));
		cache.get("b", () => createReactiveQuery({ compute: () => 2 }));
		assert.equal(cache.size, 2);
	});
});
