# Submissions

Collect votes, forms and feedback without granting viewers control over shared
content. Submissions use the KV capability: enable Backend and Key-value storage.
Each collection holds one response per authenticated user. Viewers can create,
replace, read and withdraw their own response; owners/editors can review or remove
responses. Other viewers cannot list or read them. Private `kv.user` preferences
are separate and remain invisible to owners/editors.

```js
const saved = await canvasdrop.submissions.set("lunch-round-1", { choice: "ramen" });
// { userId: "server-resolved-user", value: { choice: "ramen" }, updatedAt: 1780000000000 }
const mine = await canvasdrop.submissions.get("lunch-round-1");
await canvasdrop.submissions.delete("lunch-round-1"); // withdraw
```

The author and timestamp are server-derived. An author ID inside `value` is just
untrusted response data. Updating a response replaces it, so repeated clicks do
not create extra votes. This is one current response, not append-only history or
a system for secret ballots. An author can change or withdraw their response.

| Method | Result | Who |
|---|---|---|
| `get<T>(collection)` | `Submission<T> \| null`; missing response becomes `null`. | Own response |
| `set<T>(collection, value)` | `Submission<T>`; any JSON, including `null`. | Own response |
| `delete(collection)` | `void`; missing response is a successful no-op. | Own response |
| `list<T>(collection, { cursor?, limit? })` | `{ entries: Submission<T>[], nextCursor: string \| null }` | Owner/editor |
| `remove(collection, userId)` | `void`; remove one author's response. | Owner/editor |
| `clear(collection)` | `void`; permanently remove the collection's responses. | Owner/editor |

All results above are promises. `Submission<T>` is `{ userId: string, value: T,
updatedAt: number }`, with Unix milliseconds. Collections are 1–80 ASCII letters,
digits, dots, underscores or hyphens, starting with a letter or digit. Values and
request bodies are at most 64 KiB. List limits must be integers 1–1000 (default
100); pass a returned cursor unchanged. Counts across collections default to
10,000 per canvas and 1,000 per author, using the existing admin KV count limits
separately from shared/preferences data. Existing responses can be updated at the
count limit. Count admission, like KV admission, is a best-effort quota under
concurrent new writes.

## Review and publish a result

Keep the poll question/options in shared KV, editable by owners/editors. Collect
individual answers through submissions. An editor validates the response values,
calculates totals and explicitly publishes only the aggregate into shared KV.
Viewers read the published totals. Use a new collection for a new question/round.

```js
const me = await canvasdrop.me();
if (me.permissions.canManageSubmissions) {
  const totals = { ramen: 0, tacos: 0 };
  let cursor;
  do {
    const page = await canvasdrop.submissions.list("lunch-round-1", { cursor });
    for (const { value } of page.entries) {
      if (value?.choice === "ramen" || value?.choice === "tacos") totals[value.choice]++;
    }
    cursor = page.nextCursor || undefined;
  } while (cursor);
  await canvasdrop.kv.set("lunch-round-1-results", totals);
}
const published = await canvasdrop.kv.get("lunch-round-1-results");
```

The list is paginated live data, not a transaction snapshot. Responses may change
while an editor calculates a result. A published aggregate is a deliberate
snapshot; it does not automatically update when responses are changed or cleared.
The runnable `examples/participant-input/` includes a poll and feedback form.

## Attachments, errors and privacy

Upload an attachment with `files.upload(file, { scope: "submission" })`, then
store its returned ID in the response. File authorization remains independent:
putting another file ID in a response cannot grant access to that file. Deleting
or clearing a response does not delete attachments; remove those through the
files API when appropriate. Never broadcast private responses on realtime
`participants:` channels, which any admitted subscriber can read.

A role denial is `403 PERMISSION_DENIED` / `PermissionDeniedError`. Malformed
collections, cursors or limits are `400 INVALID_BODY`; size and count limits are
`VALUE_TOO_LARGE` (413) and `KEY_LIMIT` (409). Disabled KV returns
`CAPABILITY_DISABLED`; normal access, password, lifecycle, rate-limit and public
static-only checks apply. Reads use `Cache-Control: private, no-store`.

For the complete wire contract, see [Runtime API](/docs/api/runtime-api).
