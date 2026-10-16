# local-sync

A zero-dependency, local-first data library for TypeScript/JavaScript apps.

Your app reads and writes a local copy of its data, so the UI is instant and keeps working
offline. The library saves that copy on the device (IndexedDB) and keeps it in step with a
remote in the background. It handles the parts that are easy to get wrong: paging, retries,
offline, conflicting edits, removed items, and save-on-a-short-delay.

- **Zero runtime dependencies.** ESM only (`"type": "module"`). No framework required.
- **Two ready-made recipes** for the common cases: [read-only data from an outside
  service](#recipe-1-read-only-data-from-an-outside-service) and [simple named values you
  read and write](#recipe-2-key-value-data-you-read-and-write).
- **Safe by default.** The obvious way to use it is also the correct way. See
  [what it handles for you](#what-the-library-handles-for-you).

## Install

```sh
npm install git+https://github.com/cuptordare/local-sync.git#main
```

```ts
import { createLocalSyncApp } from "localsync";
```

Installing from git runs the `prepare` script, which builds `dist/`.

## Pick your recipe

Every app starts the same way:

```ts
const app = createLocalSyncApp({ name: "my-app" }); // name = the IndexedDB database on this device
```

Without a `name` (or a `storage` adapter), data is kept in memory only. The library warns about
that in the browser.

### Recipe 1: read-only data from an outside service

For Jira issues, Azure DevOps work items, GitHub issues, calendar events, and the like.
You write **one function that fetches one page**. The library does the rest:

```ts
interface Issue { key: string; title: string; status: string }

const issues = app.source<Issue, { project: string }>("issues", {
  // Fetch ONE page. `cursor` is undefined for the first page, then whatever you returned
  // as `nextCursor` last time. `filter` is the current filter (below).
  fetchPage: async ({ filter, cursor }) => {
    const res = await fetch(`/api/issues?project=${filter?.project}&page=${cursor ?? 1}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // ALWAYS throw on failure (see below)
    const body = await res.json();
    return { items: body.issues, nextCursor: body.nextPage }; // no nextCursor on the last page
  },
  getId: (issue) => issue.key,     // a stable, unique id for each item
  filter: { project: "ABC" },      // what to fetch; passed to fetchPage
  refreshIntervalMs: 5 * 60_000,   // re-fetch every 5 minutes (it also fetches on load and on reconnect)
});

await app.ready();                 // the copy saved on this device is loaded

const open = issues.query((i) => i.status !== "Done"); // a live list, filtered locally
render(open.getCurrentResult());   // -> Issue[]. subscribe() only reports changes, so render once first
open.subscribe(render);            // called with the new Issue[] whenever the list changes

issues.peek("ABC-12");             // -> one Issue, or undefined
issues.all();                      // -> every cached Issue
await issues.setFilter({ project: "XYZ" }); // re-fetch; items outside the new filter go away
await issues.refresh();            // re-fetch now (rejects if the fetch fails)
```

- Every page is fetched, and items are cached on the device, so they're readable offline and shown
  instantly on the next visit.
- Each refresh is a full snapshot. Items that were deleted, closed, or filtered out at the
  source **disappear locally too**.
- Items that didn't change cost nothing: no storage write, and your UI isn't re-rendered.
- The local copy is **read-only**, so it can't drift from the source.
- **Never turn a failure into an empty page.** The library treats `{ items: [] }` as "the source
  is empty" and removes everything. Throw instead. The cached copy then stays, and the failure
  shows up in `app.status` and `app.on("error")`.

Runnable: [`examples/read-only-issues`](examples/read-only-issues).

### Recipe 2: key-value data you read and write

For settings, a shared list, a schedule, or game state: named values, shared through a simple
remote. This is the complete client-side setup for a shared shopping list, with one key per item:

```ts
interface Item { text: string; done: boolean }

// 1. The remote. You write two functions: load the whole blob, and save the whole blob.
const remote = createBlobSyncAdapter<Item>({
  read: async () => {
    const res = await fetch("/api/blobs/shopping");
    if (res.status === 404) return { records: [], etag: "0" }; // nothing saved yet
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return { records: body.records, etag: res.headers.get("ETag") ?? undefined };
  },
  write: async (blob, { ifMatch }) => {
    const res = await fetch("/api/blobs/shopping", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(ifMatch ? { "If-Match": ifMatch } : {}) },
      body: JSON.stringify(blob),
    });
    if (res.status === 412) return { conflict: true }; // saved by someone else since our read
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
});

// 2. The store.
const shopping = app.keyValue<Item>("shopping", {
  remote,
  defaultValue: () => ({ text: "", done: false }), // optional: what get() returns for a key never set
  syncIntervalMs: 60_000,                          // also check for others' changes every minute
});
app.on("conflict", ({ id }) => toast(`Someone else changed "${id}" first`));

await app.ready(); // the copy saved on this device is loaded

// 3. Read and write. Every write is saved on the device at once and pushed shortly after.
shopping.set("milk", { text: "Milk", done: false });          // store a whole value
shopping.get("milk");                                         // -> { text: "Milk", done: false }
shopping.update("milk", (item) => ({ ...item, done: true })); // change part of the current value
shopping.get("milk");                                         // -> { text: "Milk", done: true }
shopping.get("eggs");                                         // -> { text: "", done: false } (the default)
shopping.delete("milk");                                      // get("milk") returns the default again

// 4. React to changes: yours, other tabs', and other devices'.
const stop = shopping.watch("milk", renderItem); // renderItem(item) now, then on every change
shopping.watchAll(renderList);                   // renderList(Map<key, Item>) now, then on every change
stop();                                          // stop watching
```

| Call | What it does |
| --- | --- |
| `get(key)` | The stored value. For a key never set: the default (not stored), or `undefined` without a `defaultValue`. Values are frozen: copy them (`{ ...item }`) rather than mutating. |
| `has(key)` | Whether the key has a stored value (a default doesn't count). |
| `set(key, value)` | Stores a whole new value, inserting or replacing. Does nothing if the value is unchanged. |
| `update(key, fn)` | Stores `fn(current)`, where `current` is what `get(key)` returns. Use it to change some fields and keep the rest. |
| `delete(key)` | Removes the key, here and on other devices. |
| `keys()`, `entries()` | The stored keys, or `[key, value]` pairs. |
| `watch(key, fn)`, `watchAll(fn)` | Call `fn` now and whenever the value(s) change. Return a function that stops watching. |

**What your server must do.** `createBlobSyncAdapter` works with any backend that stores one
JSON document per name: a Google Sheet behind Apps Script, a gist, an S3 object, a KV store. The
backend needs to:

1. **Store the blob as is.** The adapter sends `{ records: [...] }`. Save it unchanged and
   return the same thing on read. The adapter merges records itself: it reads, replaces only
   the records it's pushing, and writes back, so other devices' records are kept.
2. **Version it.** Every save changes a version stamp (the *etag*), which `read` returns. Return
   one even when nothing is saved yet (`{ records: [], etag: "0" }` above).
3. **Honor `ifMatch`.** `write` receives the etag from the read the write is based on. If the
   stored etag is different, someone else saved in between: don't save, and have `write`
   return `{ conflict: true }`. The adapter then re-reads, re-applies its changes, and tries
   again. Do the compare and the save as one step (e.g. under a lock).
4. **Fail loudly.** `read` and `write` must throw on any error. Never return an empty blob for
   a failed read.

Without etags (have `read` return none and ignore `ifMatch`), everything still works, but two
devices saving at exactly the same moment can overwrite each other's save.

**How it behaves:**

- Pushes are **debounced** (500 ms by default; `pushDebounceMs`), so typing in a field doesn't
  send a request per keystroke. A pending push is sent when the page is hidden or closed.
  Nothing is sent while you're idle.
- Others' changes are fetched on load, on reconnect, **when the user comes back to the page**
  (`syncWhenVisible`, on by default), and every `syncIntervalMs` while it stays open. A minute or
  more is usually plenty for that interval.
- If someone else saved the same key since you last synced, your edit is **detected, not
  silently overwritten**. The merge strategy decides the outcome (default: their saved version
  wins), and `app.on("conflict")` lets you tell the user.
- **Model with many small keys, not one big value.** Two people editing *different* keys never
  conflict. Two people editing the same big value (e.g. a whole list stored under one key) do,
  and one of the edits loses.

Runnable: [`examples/key-value-household`](examples/key-value-household).

### Recipe 3: custom backend and rules

For when neither fits: your own API, records with generated ids, live queries over the whole
set, or your own way of resolving conflicts. You use `app.collection`, the layer both recipes
above are built on, and write the `SyncAdapter` (the two functions that talk to your server)
yourself.

This example is a notes app against a REST API. On a conflict, it keeps both versions of the
text.

```ts
import {
  createLocalSyncApp, custom, fromGuard, preferDeletion,
  type PushRejection, type RecordEnvelope, type SyncAdapter,
} from "localsync";

interface Note { title: string; body: string }

// A note as your server sends it.
interface ServerNote {
  id: string; title: string; body: string;
  version: number;    // goes up on every save
  deleted: boolean;   // deleted notes are kept, so other devices learn about the delete
  createdAt: number; updatedAt: number;
}

// The library stores every record as { id, data, meta }. Convert the server's shape to that.
const toRecord = (n: ServerNote): RecordEnvelope<Note> => ({
  id: n.id,
  data: { title: n.title, body: n.body },
  meta: {
    version: n.version, deleted: n.deleted, createdAt: n.createdAt, updatedAt: n.updatedAt,
    dirty: false, source: "remote",
  },
});

const app = createLocalSyncApp({ name: "notes-app" });

// 1. The remote: fetch changes (pull) and save changes (push).
const remote: SyncAdapter<Note, unknown, number> = {
  // Fetch notes changed since `cursor`. It's undefined on the first pull after a page load,
  // so that pull fetches everything. Throw on any failure.
  async pull({ cursor }) {
    const res = await fetch(`/api/notes?since=${cursor ?? 0}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: { notes: ServerNote[]; nextSince: number; hasMore: boolean } = await res.json();
    return { records: body.notes.map(toRecord), cursor: body.nextSince, hasMore: body.hasMore };
  },

  // Save local changes, all in one request. A delete arrives as a record with meta.deleted.
  async push(mutations) {
    const res = await fetch("/api/notes/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mutations.map((m) => ({
        id: m.recordId,
        ...m.record.data,
        deleted: m.record.meta.deleted,
        baseVersion: m.record.meta.remoteVersion, // the server version this edit started from
      }))),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // One result per note, in the order sent: { saved } or { conflict } (the server's copy).
    const results: Array<{ saved?: ServerNote; conflict?: ServerNote }> = await res.json();

    const acked: string[] = [];
    const records: RecordEnvelope<Note>[] = [];
    const rejected: PushRejection<Note>[] = [];
    mutations.forEach(({ mutationId }, i) => {
      const result = results[i];
      if (result?.saved) {
        acked.push(mutationId);
        records.push(toRecord(result.saved)); // the saved copy, with its new version
      } else if (result?.conflict) {
        rejected.push({ mutationId, reason: "Changed by someone else", record: toRecord(result.conflict) });
      }
    });
    return { acked, records, rejected };
  },
};

// 2. Your rules.
const isNote = (d: unknown): d is Note =>
  typeof d === "object" && d !== null &&
  typeof (d as Note).title === "string" && typeof (d as Note).body === "string";

// Runs only when the same note changed here and on the server. Returns the note to keep.
const keepBothBodies = custom<Note>((local, remote) =>
  local.data.body === remote.data.body
    ? remote // same text: nothing to combine
    : {
        ...remote,
        data: { ...remote.data, body: `${remote.data.body}\n\n${local.data.body}` },
        meta: { ...remote.meta, dirty: true, source: "local" }, // dirty: push the combined note
      });

// 3. The collection.
const notes = app.collection<Note>("notes", {
  remote,
  validator: fromGuard(isNote, "Expected { title, body }"), // checks your writes AND the server's data
  merge: preferDeletion(keepBothBodies),                    // ...but a delete on either side wins
  syncIntervalMs: 60_000,
});
app.on("conflict", ({ id }) => toast(`Note ${id} was also edited elsewhere; both versions kept`));

await app.ready();

// 4. Read and write. Each record is { id, data, meta }; your values are in `data`.
const id = notes.insert({ title: "Ideas", body: "" });  // -> a generated id
notes.update(id, { body: "Ship it" });                   // change some fields
notes.replace(id, { title: "Plans", body: "Ship it" });  // replace all the fields
notes.upsert("welcome", { title: "Welcome", body: "" }); // insert or replace, at an id you choose
notes.peek(id)?.data;                                    // -> { title: "Plans", body: "Ship it" }
notes.delete(id);

// 5. Live queries. subscribe() only reports changes, so render once first.
const drafts = notes.query((note) => note.title.startsWith("Draft"));
render(drafts.getCurrentResult()); // -> RecordEnvelope<Note>[]
drafts.subscribe(render);
```

| Call | What it does |
| --- | --- |
| `insert(data, { id? })` | Adds a record and returns its id (generated unless you pass one). Throws if that id exists. |
| `update(id, patch)` | Changes the fields you pass and keeps the rest. Throws if the record doesn't exist. |
| `replace(id, data)` | Replaces all the fields. Throws if the record doesn't exist. |
| `upsert(id, data)` | Inserts or replaces. Also restores a deleted record. |
| `delete(id)` | Deletes the record, here and on the server. |
| `peek(id)` | The record now (`{ id, data, meta }`), or `undefined`. Not live. |
| `get(id)`, `query(predicate?)` | Live versions: read `getCurrentResult()`, then `subscribe` for changes. |
| `pending()` | Records with changes not yet pushed. |

**What your server must do:**

1. **Version every note.** Each save raises its `version`. Return the version with every note.
2. **Keep deleted notes** as `deleted: true` and return them from pulls, so other devices
   remove them too.
3. **Report changes since a point.** `GET /api/notes?since=N` returns the notes changed after
   `N`, including deletions, plus `nextSince` (where the next pull continues) and `hasMore`
   (whether to fetch another page now). Use a server-side change counter or timestamp for `N`,
   never the client's clock.
4. **Check the base version.** Save a note only if its stored version equals `baseVersion`
   (or it doesn't exist yet and `baseVersion` is missing). Otherwise someone else saved it
   first: don't save it, and return the stored copy as `conflict`. The library then runs your
   merge, emits `"conflict"`, and pushes the result if it's marked `dirty`.
5. **Fail loudly.** Return an error status for failures, so `pull` and `push` throw.

**Variations:**

- **No "changes since" support?** Have `pull` return every note, and set `complete: true` on the
  last page. Local notes missing from that snapshot are removed, as in Recipe 1.
- **Read-only, or no server yet?** Leave out `push`, or leave out `remote` entirely for a
  device-only store.
- **Built-in merge strategies:** `serverWins()` (default: the server's copy wins and the local
  edit is dropped), `lastWriteWins()`, `custom(fn)`, and `preferDeletion(strategy)`. See
  [Sync semantics](#sync-semantics).
- **Sync options** are the same as Recipe 2 (`syncIntervalMs`, `pushDebounceMs`, `retry`). Pass
  `autoSync: false` to sync only when you call `app.sync()` or `app.engine("notes")`.

The [sync playground](#examples) shows these pieces in action, with two clients side by side.

## Status, errors, and conflicts

One status covers everything the app syncs. Bind your "Saving… / Saved / Offline / Couldn't
sync" badge to it:

```ts
// { phase, online, pending, pushScheduled, rejected, lastError, lastSyncedAt }
renderBadge(app.status.get());   // subscribe() only reports changes, so render once first
app.status.subscribe(renderBadge);
app.on("error", ({ source, collection, error }) => report(error)); // storage, sync, invalid remote data
app.on("conflict", ({ collection, id }) => toast("Someone else changed this first"));
await app.sync(); // e.g. a "Retry" button; rejects if anything failed
```

- `phase` is `"error"` from a failed sync **until that direction (push or pull) succeeds
  again**, including while it retries in the background, so a badge shows the failure instead
  of flashing it. A sync still pulls when its push fails, so one change the server won't
  accept doesn't stop you receiving everyone else's.
- `rejected` counts changes the server refused outright. They stay on the device but aren't
  retried until edited again, so show them as "couldn't save", not "saving".
- Nothing fails silently. Background errors go to `app.on("error")`. If nothing listens,
  they're logged with `console.error`.

## What the library handles for you

These all used to be things each app had to remember:

| Instead of... | the library... |
|---|---|
| hand-rolling a debounced save | debounces pushes after local edits, and flushes them when the page is hidden or closed |
| `peek ? replace : insert` helpers | offers `set` / `upsert` (insert or replace) |
| inserting placeholder records, then hiding them from sync | provides `defaultValue`, which is never stored or pushed |
| marking pulled data "clean" in every adapter | normalizes remote data itself, so it can never be mistaken for a local edit |
| cramming a list into one record so deletions show up | removes items a full snapshot no longer contains |
| fetching only page 1 | follows `hasMore`/cursor through every page, and errors on a looping adapter |
| validating server responses by hand | runs your validator on incoming data and skips (and reports) invalid records |
| `structuredClone` on every read | freezes stored data, so mutating it throws instead of silently corrupting state |
| aggregating per-collection sync state | provides one `app.status` and one `app.sync()` |
| tabs showing stale data, and every tab polling | keeps open tabs in step through shared storage, with one tab syncing |
| last-write-silently-wins | detects conflicting edits, resolves them with the merge strategy, and reports them |
| unbounded tombstones | removes acknowledged deletes |

## Examples

All three run with no build tooling, just a browser import map pointing at the built library:

```sh
npm run build                       # emits dist/, which the examples import
cd examples/<name> && npm start     # serves the repo root and opens that example
```

| Example | What it shows |
|---|---|
| [`read-only-issues`](examples/read-only-issues) | **Recipe 1.** A GitHub-style issues dashboard against a simulated paginated API (real `Response`s, `Link` headers). Paging, snapshot removal, filters, offline copy, status. |
| [`key-value-household`](examples/key-value-household) | **Recipe 2.** A shared shopping list over a simulated Sheets-style blob server with etags and network latency, plus a live log of every request. Granular keys, saving shortly after edits, checking for others' changes, offline, conflicts, multiple devices and tabs. |
| [`vanilla-js-notes-app`](examples/vanilla-js-notes-app) | **Sync playground.** Two clients side by side on the low-level API, with merge-strategy switches, manual push/pull, and failure injection. It's for exploring edge cases, not a template. |

## Advanced: the low-level API

The recipes are thin wrappers. Everything below is what they're made of, and you can use it
directly. Each wrapper also exposes `.collection` and `.engine` (and `app.engine(name)`) as an
escape hatch.

### Core concepts

| Concept | What it is |
|---|---|
| **App** (`createLocalSyncApp`) | Owns storage, the collection registry, and the sync engines for collections with a `remote`. |
| **Collection** (`app.collection(name)` / `createCollection`) | A typed set of records: CRUD + live queries. |
| **RecordEnvelope** | `{ id, data, meta }`: your data, plus sync bookkeeping (`version`, `dirty`, `deleted`, timestamps, `source`, `remoteVersion`). |
| **ReactiveQuery** | A live, lazily-subscribed derived value (`collection.get(id)`, `collection.query()`). `subscribe` does **not** fire immediately; read `getCurrentResult()` first. |
| **SyncAdapter** | The contract for a backend: `pull` is required; `push` is optional (read-only sources are first-class). |
| **SyncEngine** (`createSyncEngine`) | Drives pull/push for one collection: paging, retries, status, offline gating, debounced auto-push. |
| **MergeStrategy** | Resolves a local-vs-remote conflict: `serverWins()` (default), `lastWriteWins()`, `custom()`, `preferDeletion()`. |

### Sync semantics

- **Optimistic, version-ordered writes.** Every mutation applies to the in-memory store
  synchronously (bumping `meta.version` and setting `meta.dirty`), then is persisted on a serialized
  queue, so writes always land in version order. Data is copied and deep-frozen on the way in.
- **The push backlog *is* `meta.dirty`.** `collection.pending()` returns the dirty records.
  A change made offline is still pending after a reload.
- **Pulls** follow pages while the adapter returns `hasMore` with a new `cursor`. A page with
  `complete: true` marks the end of a full snapshot: local clean records not seen in it are
  removed (dirty ones are kept, and nothing is removed if any page failed).
- **Remote data is normalized and checked.** Incoming records are marked `source: "remote"`,
  `dirty: false`, and stamped with `meta.remoteVersion`. Live ones go through the validator, and
  records identical to the local copy are skipped.
- **`keepPendingOnPull` (default `true`).** A pull won't overwrite a record that has un-pushed
  local edits; your change stays visible until it's pushed.
- **Conflict detection.** `meta.remoteVersion` records which remote version a local edit was
  based on. An adapter can reject a stale push with `rejected: [{ mutationId, reason, record }]`
  (the server's current copy). The engine resolves it with the merge strategy, emits `"conflict"`,
  and pushes the result if it still has local changes. A rejection *without* a `record` holds the
  change back (`status.rejected`) until it's edited again, so it's never re-sent in a loop.
  `createBlobSyncAdapter` implements all of this for you.
- **Push race protection.** Only records whose version is unchanged since the push started get
  the server's response applied or get marked synced. An edit made during the round-trip stays
  pending, now based on the version the server accepted, so it's never lost or mistaken for a
  conflict.
- **Lost replies.** Each device has a random id, kept in its storage, and local edits are
  stamped with it (`meta.writer`). If a push is saved but its reply never arrives, the next
  push finds this device's own save on the server. It recognises it as such, not as someone
  else's change, and the newer edit simply builds on it. For this, your adapter must store
  `meta.writer` and return it; `createBlobSyncAdapter` does. Adapters that don't behave as
  before, where the merge strategy resolves it.
- **`purgeDeletedOnPush` (default `false`).** Acknowledged tombstones are removed locally. Only
  turn it on if your adapter's pulls stop returning a tombstone once it's acknowledged. Adapters
  that keep tombstones, such as `createBlobSyncAdapter`, would re-add them on every pull, and a
  deleted key set again would be rejected as stale.
- **Merge strategies** run only on genuine conflicts (both sides changed):
  - `serverWins()`: the remote copy wins; the local edit is **discarded** (default).
  - `lastWriteWins()`: higher `meta.version` wins, then later `meta.updatedAt`.
  - `custom((local, remote) => merged)`: you decide. Return `meta.dirty: true` if the result
    still needs pushing.
  - `preferDeletion(strategy)`: a tombstone on either side wins outright. Wrap your strategy
    with it if a pending delete must never be resurrected by a racing pull.
- **Error handling.** Calling `engine.pull()/push()/sync()` (or `app.sync()`) yourself rejects on
  failure. Background work (auto-push, intervals, reconnects) never rejects; it reports through
  `sync:error` / `app.on("error")` and `status`.
- **Retry/backoff** is exponential with jitter: `retry: { maxAttempts, baseDelayMs, maxDelayMs, factor, jitter }`.
- **Before loading finishes.** The engine waits for the collection to load before syncing. Local
  writes need the stored data first, so every write before then (`insert`, `upsert`/`set`,
  `update`, `replace`, `delete`) throws a clear "await app.ready()" error, rather than guessing.
  Reads work right away and fill in once loading finishes. If loading fails, it's retried on the
  next sync (or `collection.load()`).
- **`delete()` is idempotent** once loaded: deleting a missing or already-deleted record is a no-op.
  **`insert()` throws** if a record already exists at the given `id`; use `upsert()` to replace.

### Storage adapters

- **IndexedDB** is used automatically when you pass `name` in a browser. Directly:
  `createIndexedDBAdapter({ databaseName })`. It uses one object store for all collections, opens
  lazily, and steps aside if a newer version of the app needs to upgrade the database.
- **`createMemoryAdapter()`**: data is lost on reload. Good for tests and Node.
- **Your own**: implement `StorageAdapter`. `read`/`readAll` must return copies, because
  collections freeze what they load. If several tabs share it, also implement `update`
  (read, decide and write as one atomic step, like an IndexedDB readwrite transaction):
  without it, another tab's write can slip in between a read and a write, and an edit can be
  lost. The built-in adapters implement it.

### Multi-tab

When an app persists to IndexedDB via `name`, its open tabs share that database, and the app
keeps them consistent automatically:

- An edit in one tab shows up in the others right away. After a write lands, the tab
  announces it, and other tabs re-read just those records from storage.
- **Only one tab syncs automatically.** It's elected with the browser's Web Locks API: the
  first tab leads, and when it closes or crashes, the browser hands the lock to the next tab
  right away, with no timers or heartbeats. Other tabs show the leader's `app.status`. Manual
  `app.sync()` works from any tab.
- A source's `setFilter` is shared, so the syncing tab fetches what the tabs show. There is one
  shared copy of the data, so all tabs show the latest filter's items. Other tabs aren't told
  the filter changed, so if your UI shows the current filter (e.g. a dropdown), keep that
  setting in shared storage too, such as `localStorage`.

Multi-tab needs Web Locks (`navigator.locks`) and `BroadcastChannel`, which all current major
browsers have; where either is missing, it's simply off and each tab syncs on its own. It's
also off for a custom `storage` (which may not be shared). Pass `multiTab: true` if yours is,
or `multiTab: false` to opt out. To run it outside a browser (e.g. in tests), pass
`multiTab: { channel, locks }`: any `TabChannel` (such as `createInMemoryChannelHub().connect()`)
and any object with `LockManager`'s `request(name, callback)` shape.

`createMultiTabSync()` (heartbeat-based leader election plus `broadcast()`/`onBroadcast()`) is
also exported as a separate primitive for building your own coordination.

### Validation

Collections accept any `Validator<T>`. It runs on local writes (which throw `ValidationError`)
and on incoming remote data (invalid records are skipped and reported):

```ts
import { fromGuard } from "localsync";

const isNote = (d: unknown): d is { text: string } =>
  typeof d === "object" && d !== null && typeof (d as { text?: unknown }).text === "string";

app.keyValue("notes", { validator: fromGuard(isNote, "Expected { text: string }") });
```

Wrap any schema library's `.parse`/`.safeParse` the same way; nothing is bundled.

### What's public vs. internal

`src/index.ts` is the only supported entry point. `debounce`, `deepEqual`, `deepFreeze`,
`createDisposableBag`, `createId`, `now`, `createCollectionStore`, `buildMutations`,
`defaultSleep`, and `EventBus`/`createEventBus` are internal and may change without notice.

## Dev workflow

```sh
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm run lint        # biome check --write
npm run test            # node:test unit tests (runs against src/ via tsx)
npm run test:fuzz       # quick randomized sync scenarios (25 seeds, ~5s)
npm run test:fuzz:long  # the same, 500 seeds (~1.5 min)
npm run test:e2e        # Playwright against a real browser (builds dist/ first)
npm run test:all        # unit + quick fuzz + e2e
```

There is no CI yet. Run `npm run test:all` before submitting changes, and
`npm run test:fuzz:long` too after changing anything in sync, storage, or multi-tab code.

### Randomized tests

`test/fuzz/` simulates two devices with two tabs each, editing shared keys while syncing
through one server, with random latency, outages, offline periods, failed loads and tab
reloads. After each scenario settles it checks that every tab and every device's storage
agree with the server, and that no edit was lost. That is, a key ends with its last write, or
with a concurrent write that the last one never saw.

A failure names its seed and lists the operations. To dig into one:

```sh
FUZZ_SEED=42 npm run test:fuzz                  # rerun just that seed
FUZZ_SEED=42 FUZZ_TRACE=d0:x npm run test:fuzz  # also log every change to key "d0:x"
```

(In PowerShell: `$env:FUZZ_SEED=42; npm run test:fuzz`.) Timing is part of each scenario, so
a failure may take a few reruns to reproduce.

## Status

Pre-release (`0.0.0`). No LICENSE file is present in this repository yet.
