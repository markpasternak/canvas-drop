# Authoring

Let a signed-in viewer of your canvas create and **manage** canvases from the page —
as themselves, with real ownership and no secret in the browser. A share created here
is a **managed artifact**: you `publish` it once, `update` it in place (same URL) as its
content changes, `list` your shares with their live status, and `revoke` one when it's
done. The `canvasdrop.canvases` namespace wraps `publish`, `update`, `list`, and `revoke`.

This is the **authoring** capability. It is off by default and higher-privilege
than the other primitives: the owner turns it on in the **Backend** tab *and* the
operator must enable it for the instance. Guests and public-link visitors can't
use it — creation needs a signed-in org member.

```js
// Create a durable share once.
const share = await canvasdrop.canvases.publish({
  title: "Team roadmap — Q3 snapshot",
  access: "public_link",             // audience; defaults to "private"
  password: "optional-extra-lock",   // independent of the audience
  tags: ["roadmap"],
  metadata: { sourceApp: "product-roadmap", sourceKind: "roadmap-share", theme: "light" },
  expiresAt: Date.now() + 7 * 864e5, // optional; the operator may require/limit it
  bundle: zipBlob,                   // a static-site zip (Blob or ArrayBuffer)
});
// share.url is the live canvas; it now appears in the viewer's own dashboard.

// Later — update IN PLACE. The URL never changes; a new version is deployed.
await canvasdrop.canvases.update(share.id, {
  bundle: newZipBlob,                // omit to change only settings/metadata
  metadata: { ...share.metadata, itemCount: 42, generatedAt: Date.now() },
});

// The management view — filter to this app's shares.
const mine = await canvasdrop.canvases.list({ sourceApp: "product-roadmap" });
//    → [{ id, url, title, status, access, expiresAt, updatedAt, metadata, ... }]

// Retire a share. Its URL goes dead, but it STAYS in list() as status "revoked".
await canvasdrop.canvases.revoke(share.id);
```

## Methods

| Method | Returns |
| --- | --- |
| `publish(options)` | `Promise<AuthoredCanvas>` — creates, deploys, and configures a new share |
| `update(id, options)` | `Promise<AuthoredCanvas>` — replaces the bundle and/or settings **at the same URL** |
| `list(filter?)` | `Promise<AuthoredCanvas[]>` — the viewer's shares (incl. revoked/expired), optionally filtered |
| `revoke(id)` | `Promise<void>` — make a share's public URL unavailable; it stays listed as `revoked` |

### `AuthoredCanvas`

What `publish`, `update`, and each `list` entry return — a share plus its management state:

| Field | Type | Notes |
| --- | --- | --- |
| `id` / `url` | `string` | stable id and public URL (the URL never changes across updates) |
| `title` / `tags` | `string` / `string[]` | |
| `access` | `string` | the current audience rung |
| `hasPassword` | `boolean` | whether an additional password lock is currently set |
| `discoverability` | `"link_only" \| "listed"` | whether eligible org/team shares appear in discovery surfaces |
| `galleryTemplatable` | `boolean` | whether gallery viewers may use the canvas as a template |
| `viewerRole` | `"owner" \| "editor" \| "admin"` | why the current viewer may manage this record |
| `audienceSummary` | `{ count: number \| null; names: string[] }` | safe summary of the viewer people and teams on the list (`count` = both; `names` = the teams) |
| `status` | `"live" \| "expired" \| "revoked" \| "private"` | derived; precedence `revoked` › `expired` › `private` › `live` |
| `createdAt` / `updatedAt` | `number` | unix ms |
| `expiresAt` / `revokedAt` | `number \| null` | share expiry; when it was revoked |
| `galleryListed` | `boolean` | whether the canvas is explicitly listed in the gallery |
| `createdBy` | `string` | the creator (owner) id |
| `version` | `string \| null` | the current version id — advances on every bundle deploy (a change signal) |
| `bundleUpdatedAt` | `number` | legacy last-change stamp; use `version` to detect bundle changes |
| `sourceApp` / `sourceKind` | `string \| null` | pulled from `metadata` (the filterable dimensions) |
| `metadata` | `Record<string, unknown>` | your free-form blob, round-tripped verbatim |

### `publish` options

| Field | Type | Notes |
| --- | --- | --- |
| `title` | `string` | required |
| `bundle` | `Blob \| ArrayBuffer` | required — the static-site **zip** |
| `slug` | `string?` | omit for a readable-random slug |
| `tags` | `string[]?` | |
| `access` | `"private" \| "specific_people" \| "whole_org" \| "public_link" \| "password"?` | General access; defaults to `"private"` (Restricted: the people-and-teams list only). `"specific_people"` is a legacy alias of `"private"`; `"password"` remains a compatibility shorthand for public link + password |
| `password` | `string?` | optional extra lock on any audience; required with the `"password"` shorthand |
| `expiresAt` | `number?` | unix ms; the operator may require an expiry and cap how far out it may be |
| `metadata` | `Record<string, unknown>?` | free-form structured state (`sourceApp`/`sourceKind`/`theme`/…), bounded in size |

### `update` options

Every field is optional — omitted fields leave the share unchanged. `password` and
`expiresAt` accept `null` to explicitly clear them. Omit `bundle` to change only
settings/metadata (the URL and current version stay put).

| Field | Type | Notes |
| --- | --- | --- |
| `bundle` | `Blob \| ArrayBuffer?` | a new static-site **zip** → a new immutable version at the **same URL** |
| `title` | `string?` | |
| `tags` | `string[]?` | |
| `access` | `"private" \| "specific_people" \| "whole_org" \| "public_link" \| "password"?` | re-checks the same operator gates as publish |
| `password` | `string \| null?` | set, or `null` to clear |
| `expiresAt` | `number \| null?` | set, or `null` to clear |
| `metadata` | `Record<string, unknown>?` | replaces the stored blob |
| `expectedUpdatedAt` | `number?` | compare-and-swap token from the last read; stale updates reject with `SHARE_CONFLICT` |

`publish` and `update` each send one `multipart/form-data` request
(`credentials: "include"`): a JSON `metadata` part plus (optionally, for `update`) the
zip `bundle` part.

### `list` filter

`list()` returns every active canvas record the viewer can currently manage as owner or
editor — **including**
unpublished and expired ones, but excluding archived, deleted, and admin-disabled
canvases — so a management UI can show recoverable records. Pass a filter to narrow server-side:

```js
await canvasdrop.canvases.list({ sourceApp: "product-roadmap" });
await canvasdrop.canvases.list({ sourceKind: "roadmap-share", tags: ["q3"] });
```

`{ sourceApp?, sourceKind?, tags? }` — `sourceApp`/`sourceKind` match the values inside
`metadata`; `tags` matches shares carrying **every** listed tag.

## Update, revoke, and status

- **Update is in place.** `update` deploys a new immutable version to the **same**
  canvas — the public URL never changes, and version history + one-click rollback are
  preserved. Use it instead of `publish` when re-sharing the same artifact.
- **Unpublish keeps the record.** `revoke` makes the public URL unavailable (readers get
  not-found) and stamps `revokedAt`, but the share **stays in `list()`** as
  `status: "revoked"`. Calling `update` with a bundle publishes it again at the same
  URL and clears `revokedAt`. A settings-only update while unpublished rejects with
  `SHARE_REVOKED`.
- **Status is derived** from access + expiry + revoked state: `revoked` › `expired` ›
  `private` › `live`. Only a `live` share is reachable by a reader.
- **Reader isolation.** A public/permitted reader receives only the shared static
  content — never `metadata`, `createdBy`, `status`, or any management field. Those are
  assembled only on the authenticated management API.

## Ownership, quotas, and authorization

- The new share is owned by the **viewer** who called `publish`. It counts against
  their normal canvas ownership **and** a per-viewer authoring quota (a daily and an
  all-time cap the operator sets).
- Quota is consumed the moment the canvas is **created** by `publish` — a
  `PublishFailedError` still counts, since the canvas exists. **`update` does not consume
  quota** (it edits an existing share). `revoke` does not refund quota.
- `list` is scoped to shares the viewer currently manages as owner or editor. An
  administrator may still update or revoke a known share id through the explicit admin
  allowance; an unauthorized id reads as **not-found**.
- `expiresAt` uses the same share-expiry mechanism as the dashboard, so it only means
  something for people other than the owner and editors.

## Errors

Every method rejects with a `CanvasdropError` subclass — catch the one you care about,
or read `err.code` / `err.status`.

- Not a signed-in member (a guest / public visitor) → `NotAuthenticatedError`
  (`status: 401`, `code: "NOT_AUTHENTICATED"`).
- Authoring off (backend off, the per-canvas toggle off, or the operator switch off) →
  `CapabilityDisabledError` (`status: 403`, `code: "CAPABILITY_DISABLED"`).
- Per-viewer daily or all-time cap hit → `QuotaExceededError` (`status: 429`,
  `code: "QUOTA_EXCEEDED"`, with a `scope` of `user_daily` or `user_total`).
- Invalid request (bundle or metadata too large, a disallowed access rung, a
  missing/over-max expiry) → `CanvasdropError` (`status: 400`/`413`, `code: "INVALID_BODY"`).
- settings-only `update` on a share that's unpublished → `CanvasdropError`
  (`status: 409`, `code: "SHARE_REVOKED"`) — include a bundle to publish it again.
- An `expectedUpdatedAt` token is stale → `CanvasdropError`
  (`status: 409`, `code: "SHARE_CONFLICT"`) with the current share state; refresh before retrying.
- The canvas was created but its deploy or share-config failed →
  `PublishFailedError` (`status: 502`, `code: "PUBLISH_FAILED"`). Its `.id` is the new
  canvas's id, so you can retry the publish or `canvasdrop.canvases.revoke(id)`.
- `update` saved the settings but the bundle deploy then failed →
  `UpdatePartialError` (`status: 502`, `code: "UPDATE_PARTIAL"`). `.stage` names the
  failed stage and `.current` is the saved share state, so nothing you changed is lost;
  retry the `update` with the bundle.

See [error codes](/docs/api/errors). The underlying HTTP endpoints live under
`/v1/c/<slug>/authoring` — see the [Runtime API](/docs/api/runtime-api).
