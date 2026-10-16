# local-sync

A zero-dependency, local-first data library for TypeScript/JavaScript apps.

Your app reads and writes a local copy of its data, so the UI is instant and keeps working
offline. The library saves that copy on the device (IndexedDB) and keeps it in step with a
remote in the background. It handles the parts that are easy to get wrong: paging, retries,
offline, edits made at the same time on several devices, removed items, and
save-on-a-short-delay.

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
    if (res.status === 404) return { etag: "0" }; // nothing saved yet
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ...(await res.json()), etag: res.headers.get("ETag") ?? undefined };
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

1. **Store the blob as is.** The library sends `{ format: "lww-1", entries: { ... } }` (one
   entry per key, see [Sync semantics](#sync-semantics)). Save it unchanged and return the
   same thing on read. A save always contains every device's keys: the library reads, merges
   its changes in, and writes the result back.
2. **Version it.** Every save changes a version stamp (the *etag*), which `read` returns. Return
   one even when nothing is saved yet (`{ etag: "0" }` above).
3. **Honor `ifMatch`.** `write` receives the etag from the read the write is based on. If the
   stored etag is different, someone else saved in between: don't save, and have `write`
   return `{ conflict: true }`. The library then re-reads, merges again, and tries again. Do
   the compare and the save as one step (e.g. under a lock).
4. **Fail loudly.** `read` and `write` must throw on any error. Never return an empty blob for
   a failed read.

Without etags (`read` returns none and `ifMatch` is ignored), two devices saving at exactly
the same moment can overwrite one save, and nothing notices. Use them.

**Size.** Every read and save moves the whole collection: about 80 characters per key plus
its value (deletes stay for 30 days). Mind your backend's limit, e.g. a Google Sheets cell
holds 50,000 characters. Split large data over several stores (each is its own blob).

**How it behaves:**

- Pushes are **debounced** (500 ms by default; `pushDebounceMs`), so typing in a field doesn't
  send a request per keystroke. A pending push is sent when the page is hidden or closed.
  Nothing is sent while you're idle.
- Others' changes are fetched on load, on reconnect, **when the user comes back to the page**
  (`syncWhenVisible`, on by default), and every `syncIntervalMs` while it stays open. A minute or
  more is usually plenty for that interval.
- **Edits made at the same time are combined, not lost.** If someone saves a key while your
  device still has an unsaved edit to it (even one made from an old view), the two edits are
  merged: objects field by field, lists item by item. Only where both changed the *same*
  thing does the later edit win. See [Concurrent edits](#concurrent-edits). Every device ends
  with the same value.
- **Two people editing *different* keys never interact at all**, so many small keys is still
  the most predictable model where people collaborate a lot.
- **Moving from an older version of this library?** See [Upgrading from the
  `{ records }` format](#upgrading-from-the--records--format).

Runnable: [`examples/key-value-household`](examples/key-value-household).

### Recipe 3: records with generated ids, or your own backend

For when neither recipe fits: records with generated ids and live queries over the whole set
(`app.collection`, the layer both recipes are built on), or a backend that isn't "one blob"
(write the `SyncAdapter` yourself).

```ts
import { createLocalSyncApp, fromGuard, type SyncAdapter, type Entry } from "localsync";

interface Note { title: string; body: string }

const isNote = (d: unknown): d is Note =>
  typeof d === "object" && d !== null &&
  typeof (d as Note).title === "string" && typeof (d as Note).body === "string";

// A remote is two functions: read every entry, and write them back unless someone else
// wrote since that read. Here: a JSON document behind an HTTP API with ETags.
const remote: SyncAdapter<Note> = {
  async read() {
    const res = await fetch("/api/notes");
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // always throw on failure
    const body: { entries: Record<string, Entry<Note>> } = await res.json();
    return { entries: new Map(Object.entries(body.entries)), etag: res.headers.get("ETag") ?? undefined };
  },
  async write(entries, { ifMatch }) {
    const res = await fetch("/api/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(ifMatch ? { "If-Match": ifMatch } : {}) },
      body: JSON.stringify({ entries: Object.fromEntries(entries) }),
    });
    if (res.status === 412) return { conflict: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
};

const app = createLocalSyncApp({ name: "notes-app" });
const notes = app.collection<Note>("notes", {
  remote,
  validator: fromGuard(isNote, "Expected { title, body }"), // checks your writes; hides bad remote data
  syncIntervalMs: 60_000,
});
await app.ready();

// Read and write. Each record is { id, data, meta }; your values are in `data`.
const id = notes.insert({ title: "Ideas", body: "" });  // -> a generated id
notes.update(id, { body: "Ship it" });                   // change some fields
notes.replace(id, { title: "Plans", body: "Ship it" });  // replace all the fields
notes.upsert("welcome", { title: "Welcome", body: "" }); // insert or replace, at an id you choose
notes.peek(id)?.data;                                    // -> { title: "Plans", body: "Ship it" }
notes.delete(id);

// Live queries. subscribe() only reports changes, so render once first.
const drafts = notes.query((note) => note.title.startsWith("Draft"));
render(drafts.getCurrentResult()); // -> RecordEnvelope<Note>[]
drafts.subscribe(render);
```

| Call | What it does |
| --- | --- |
| `insert(data, { id? })` | Adds a record and returns its id (generated unless you pass one). Throws if a record exists at that id. |
| `update(id, patch)` | Changes the fields you pass and keeps the rest. Throws if the record doesn't exist. |
| `replace(id, data)` | Replaces all the fields. Throws if the record doesn't exist. |
| `upsert(id, data)` | Inserts or replaces. Also restores a deleted record. |
| `delete(id)` | Deletes the record, here and on the server. |
| `peek(id)` | The record now (`{ id, data, meta }`), or `undefined`. Not live. |
| `get(id)`, `query(predicate?)` | Live versions: read `getCurrentResult()`, then `subscribe` for changes. |
| `pending()` | The ids with changes the remote doesn't have yet (deletes included). |

**What your server must do:** the same as for Recipe 2: store what `write` sends, return it
from `read`, version it with an etag, refuse a write whose `ifMatch` is stale, and fail
loudly. It never has to understand the entries: merging happens in the library.

- **Read-only, or no server yet?** Leave out `write`, or leave out `remote` entirely for a
  device-only store.
- **Sync options** are the same as Recipe 2 (`syncIntervalMs`, `pushDebounceMs`, `retry`). Pass
  `autoSync: false` to sync only when you call `app.sync()` or `app.engine("notes")`.

The [sync playground](#examples) shows these pieces in action, with two clients side by side.

## Status and errors

One status covers everything the app syncs. Bind your "Saving… / Saved / Offline / Couldn't
sync" badge to it:

```ts
// { phase, online, pending, pushScheduled, lastError, lastSyncedAt }
renderBadge(app.status.get());   // subscribe() only reports changes, so render once first
app.status.subscribe(renderBadge);
app.on("error", ({ source, collection, error }) => report(error)); // storage, sync, invalid remote data, merge
await app.sync(); // e.g. a "Retry" button; rejects if anything failed
```

- `phase` is `"error"` from a failed sync **until that direction (push or pull) succeeds
  again**, including while it retries in the background, so a badge shows the failure instead
  of flashing it. A push reads and merges the remote before it writes, so even a push that
  keeps failing doesn't stop you receiving everyone else's changes.
- `pending` counts keys with changes the remote doesn't have yet. They're kept on the device
  (also across reloads) and pushed on the next successful sync.
- Nothing fails silently. Background errors go to `app.on("error")`. If nothing listens,
  they're logged with `console.error`.

## What the library handles for you

These all used to be things each app had to remember:

| Instead of... | the library... |
|---|---|
| hand-rolling a debounced save | debounces pushes after local edits, and flushes them when the page is hidden or closed |
| `peek ? replace : insert` helpers | offers `set` / `upsert` (insert or replace) |
| inserting placeholder records, then hiding them from sync | provides `defaultValue`, which is never stored or pushed |
| tracking what still needs saving | knows per key whether the remote has the latest write, across reloads |
| cramming a list into one record so deletions show up | keeps deletes as entries, and removes items a full snapshot no longer contains |
| fetching only page 1 | follows every page, and errors on a looping `fetchPage` |
| validating server responses by hand | runs your validator on incoming data, and hides (and reports) invalid values |
| `structuredClone` on every read | freezes stored data, so mutating it throws instead of silently corrupting state |
| aggregating per-collection sync state | provides one `app.status` and one `app.sync()` |
| tabs showing stale data, and every tab polling | keeps open tabs in step, with one tab syncing |
| a save erasing another device's changes | merges per key on every save, with compare-and-swap |
| writing merge code for edits made at the same time | merges them (fields, list items), the same on every device |

## Limits

Worth knowing before you pick it:

- **Read-only sources re-fetch everything.** Each refresh downloads every page, which is
  simple and always correct, and fine for hundreds or a few thousand items, but costly for
  very large data sets. `fetchPage` must throw on any failure: an empty page empties the cache.
- **A key-value store is one blob.** Every read and save moves the whole store: about 80
  characters per key plus its value (deletes stay for 30 days). Mind your backend's limit,
  e.g. a Google Sheets cell holds 50,000 characters. Split large data over several stores.
- **The backend needs etags** (see [What your server must do](#recipe-2-key-value-data-you-read-and-write)).
  Without them, two devices saving at the same moment can lose one save, silently.
- **Merges are by field and by item, not by text.** Two edits of the same field (one note's
  text, say) aren't combined: the later one wins. A list of strings, numbers or booleans is
  merged as a set, so duplicates in it collapse into one. A list of objects is merged item by
  item only if every item has a unique `id`; otherwise the later edit wins for the whole list.
- **Deletes are kept for 30 days.** A device offline for longer, with an unsaved edit to a key
  deleted meanwhile, brings that key back.

## Examples

All three run with no build tooling, just a browser import map pointing at the built library:

```sh
npm run build                       # emits dist/, which the examples import
cd examples/<name> && npm start     # serves the repo root and opens that example
```

| Example | What it shows |
|---|---|
| [`read-only-issues`](examples/read-only-issues) | **Recipe 1.** A GitHub-style issues dashboard against a simulated paginated API (real `Response`s, `Link` headers). Paging, snapshot removal, filters, offline copy, status. |
| [`key-value-household`](examples/key-value-household) | **Recipe 2.** A shared shopping list over a simulated Sheets-style blob server with etags and network latency, plus a live log of every request. Granular keys, saving shortly after edits, checking for others' changes, offline, multiple devices and tabs. |
| [`vanilla-js-notes-app`](examples/vanilla-js-notes-app) | **Sync playground.** Two clients side by side on the low-level API, with manual push/pull, offline toggles, and failure injection, to watch concurrent edits resolve. It's for exploring edge cases, not a template. |

## Advanced: the low-level API

The recipes are thin wrappers. Everything below is what they're made of, and you can use it
directly. Each wrapper also exposes `.collection` and `.engine` (and `app.engine(name)`) as an
escape hatch.

### Core concepts

| Concept | What it is |
|---|---|
| **App** (`createLocalSyncApp`) | Owns storage, the collection registry, and the sync engines for collections with a `remote`. |
| **Collection** (`app.collection(name)` / `createCollection`) | A typed set of records: CRUD + live queries, stored as one LWW map. |
| **Entry** | What's stored per key: `{ value, deleted, stamp, device }`. Deletes are entries too. |
| **LWW map** | Entries by key. Merging two keeps, per key, the entry with the greater `(stamp, device)`. |
| **Hybrid logical clock** (`createHybridClock`) | Makes the stamps: wall-clock time, but always later than every stamp it has seen. |
| **RecordEnvelope** | What reads return: `{ id, data, meta: { stamp, device, updatedAt } }`. Frozen. |
| **ReactiveQuery** | A live, lazily-subscribed derived value (`collection.get(id)`, `collection.query()`). `subscribe` does **not** fire immediately; read `getCurrentResult()` first. |
| **SyncAdapter** | The contract for a remote: `read()` all entries, and `write(entries, { ifMatch })` (optional: read-only remotes are first-class). |
| **SyncEngine** (`createSyncEngine`) | Drives pull/push for one collection: retries, status, offline gating, debounced auto-push. |

### Sync semantics

The data model is a textbook state-based CRDT: a **last-writer-wins map** ordered by a **hybrid
logical clock**. Everything else follows from it.

- **Entries and stamps.** Each key holds one entry: `{ value, deleted, stamp, device }`. The
  `stamp` is `wall-clock ms * 1000 + a counter`, from a clock that never goes backwards and
  always moves past any stamp it has received. So a write made after seeing another write gets
  a later stamp, even if this device's clock is behind. `device` is a random id kept per device,
  plus a short id per tab, so no two writes share a `(stamp, device)`.
- **One merge for everything.** A local write, a pull, another tab's write, the stored copy:
  each is merged the same way, keeping per key the entry with the greater `(stamp, device)`.
  The merge is commutative, associative and idempotent, so it doesn't matter in what order, or
  how often, things arrive. A stale pull, a push repeated after its reply was lost, two tabs
  syncing at once, or a message from another tab arriving late can't undo a newer write.
- **Concurrent edits** to one key are merged before either replaces the other; see
  [Concurrent edits](#concurrent-edits).
- **Deletes** are entries with `deleted: true` ("tombstones"), so other devices learn about them
  and an older write can't bring the value back. They're kept for **30 days** (about 90
  characters each), then a push drops them, and each device removes the key once its own copy
  is that old too. So a device offline for over 30 days, with an unsaved edit to a key deleted
  meanwhile, brings that key back. (`createSyncEngine`'s `tombstoneTtlMs` changes the 30 days.)
- **A remote that comes back empty** (its document cleared, lost, or moved) never deletes
  anything on a device: the next sync pushes the device's data back into it. So does any read
  showing the remote lacks entries a device holds.
- **Pull** reads the remote's entries and merges them in. **Push** reads, merges, and if this
  side has entries the remote lacks, writes the merge of both with `ifMatch`; on
  `{ conflict: true }` it reads, merges and tries again.
- **Use etags, and never roll the remote back.** A device remembers which writes the remote
  holds, and doesn't send them again. Without etags, two devices saving at the same moment can
  overwrite one save, and the device that made it won't notice (until that key is edited
  again). The same goes for restoring an older copy of the blob: to start over, save under a
  new name instead.
- **Pending.** A key is pending while its entry is newer than the newest one the remote is
  known to hold. That's tracked per key in storage, so a change made offline is still pending
  after a reload. `status.pending` counts them.
- **Remote data is validated, but can't be refused.** Every device has to hold the same entries
  to agree, so an entry whose value fails your validator is kept but hidden: reads treat the key
  as missing, and it's reported as an app `"error"` (`source: "remote-validation"`), until a
  valid write replaces it.
- **Clocks.** A device whose clock is far ahead wins ties of "who wrote last" for edits made at
  about the same time, and pulls every other clock forward with it (stamps never go back). Edits
  made after seeing its write still win, as always.
- **Error handling.** Calling `engine.pull()/push()/sync()` (or `app.sync()`) yourself rejects on
  failure. Background work (auto-push, intervals, reconnects) never rejects; it reports through
  `sync:error` / `app.on("error")` and `status`.
- **Retry/backoff** is exponential with jitter: `retry: { maxAttempts, baseDelayMs, maxDelayMs, factor, jitter }`.
- **Before loading finishes.** The engine waits for the collection to load before syncing. Local
  writes need the stored data first (a write must be stamped after everything it could have
  seen), so every write before then throws a clear "await app.ready()" error. Reads work right
  away and fill in once loading finishes. If loading fails, it's retried on the next sync, by
  `app.ready()`, or by `collection.load()`.
- **`delete()` is idempotent** once loaded: deleting a missing or already-deleted record is a
  no-op. **`insert()` throws** if a record exists at the given `id`; use `upsert()` to replace.
- **Sources** (`app.source`) don't sync entries: each refresh fetches every page and makes the
  local copy hold exactly what came back. Unchanged items keep their entry (no write, no
  re-render), and removed ones are deleted outright.

### Concurrent edits

The LWW map keeps devices in agreement, but on its own the later of two concurrent edits
would replace the earlier one entirely, e.g. a phone that has shown the shopping list for an
hour saving it without the items someone added meanwhile. So each unsaved edit remembers the
value it started from (its *base*), and when a device reads the remote (on a pull, or just
before it saves) and finds that someone else saved the key since that base, it merges the
three and saves the result as a new write. That write is ordered right after the later of the
two edits (it takes that edit's stamp, and its `device` is that edit's with `~<this tab>`
added), so it wins over both on every device, and it contains both, while an edit made after
either of them (say in another tab, not yet heard of) still wins over it.

The default merge, `mergeValues`:

| Both sides changed... | Result |
|---|---|
| different fields of an object | both changes (merged recursively) |
| a list of strings/numbers/booleans | a set merge: both sides' additions kept, both sides' removals applied |
| a list of objects that each have an `id` | merged item by item; an item one side removed and the other changed is kept |
| the same field, or anything else, to different values | the later edit wins |

Not merged: an edit against a delete (the later write wins), edits from two tabs of one device
(they see each other at once), and a merge result your validator refuses or a `merge` function
that throws (the later write wins, and it's reported as an app `"error"` with
`source: "merge"`). Lists merged as sets treat equal items as one.

Your own rules go in `merge`, per store; it runs only in that situation, and returns the
value to save:

```ts
const todos = app.keyValue<Todo>("todos", {
  remote,
  merge: (base, mine, theirs, { key, mineIsLater }) =>
    mergeValues(base, mine, theirs, { key, mineIsLater }), // e.g. adjust the default's result
});
app.on("merged", ({ collection, id, mine, theirs, result }) => {
  // e.g. "Combined with someone else's changes" -- and where the later edit won a change
  // both made, offer "Keep mine": todos.set(id, mine)
});
```

### Storage adapters

- **IndexedDB** is used automatically when you pass `name` in a browser. Directly:
  `createIndexedDBAdapter({ databaseName })`. It uses one object store for all collections, opens
  lazily, and steps aside if a newer version of the app needs to upgrade the database.
- **`createMemoryAdapter()`**: data is lost on reload. Good for tests and Node.
- **Your own**: implement `StorageAdapter`: `readAll`, `merge`, `remove` and `close`. `merge` must
  merge, not overwrite (use the exported `mergeStored` per key), and must read and write as
  one atomic step (like an IndexedDB readwrite transaction) if several tabs share the storage.
  `readAll` must return copies, because collections freeze what they load.

### Multi-tab

When an app persists to IndexedDB via `name`, its open tabs share that database, and the app
keeps them consistent automatically:

- An edit in one tab shows up in the others right away. After a write lands in storage, the
  tab sends the stored entries to the other tabs, which merge them. Since storage is written by
  merging too, tabs and storage agree whatever order things happen in.
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

### Validation

Collections accept any `Validator<T>`. It runs on local writes (which throw `ValidationError`)
and on values from elsewhere (invalid ones are hidden and reported):

```ts
import { fromGuard } from "localsync";

const isNote = (d: unknown): d is { text: string } =>
  typeof d === "object" && d !== null && typeof (d as { text?: unknown }).text === "string";

app.keyValue("notes", { validator: fromGuard(isNote, "Expected { text: string }") });
```

Wrap any schema library's `.parse`/`.safeParse` the same way; nothing is bundled.

### Upgrading from the `{ records }` format

Versions of this library before the LWW map stored "records" (`{ id, data, meta }`), on the
device and in remote blobs (`{ records: [...] }`). Both are imported automatically:

- **On the device**, the IndexedDB adapter leaves the old rows where they are and imports them
  when a collection loads. Each record becomes an entry stamped from its `meta.updatedAt`,
  written by the fixed device `"legacy"`, so every device imports the same record identically.
- **The remote**: save the new format under a **new** name, and pass the old one as `legacy`:

  ```ts
  createBlobSyncAdapter<Item>({
    read: () => api.get("shopping:lww"),
    write: (blob, { ifMatch }) => api.set("shopping:lww", blob, ifMatch),
    legacy: { read: () => api.get("shopping") }, // only read, never written
  });
  ```

  While the new blob is empty, the old one is imported, and the next push saves the merge into
  the new blob. The old one stays as it was, as a backup. Don't write the new format over the
  old name: an older app version would read no records there, and save over it. The adapter
  refuses to read an old-format blob as the new one, for the same reason.
- Edits made with the new version are stamped later than the data they were made from, so
  they win over imported values. An old app version still running somewhere keeps using the old
  storage and blob; its later edits are picked up when that device loads the new version (the
  local import runs on every load and only takes records newer than what's stored).

### What's public vs. internal

`src/index.ts` is the only supported entry point. `debounce`, `deepEqual`, `deepFreeze`,
`createDisposableBag`, `createId`, `now`, `createEngine`, `defaultSleep`, and
`EventBus`/`createEventBus` are internal and may change without notice.

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
through one server, with random latency, outages, lost replies, offline periods, failed loads
and tab reloads. After each scenario settles it checks that every tab and every device's storage
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
