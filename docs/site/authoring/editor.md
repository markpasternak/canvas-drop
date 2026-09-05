# The editor

Change a canvas's files in the browser, check the result, and publish when you are
ready. Nothing viewers see changes until you publish. The editor is the **Editor**
tab of any canvas you own or edit; there is no local setup and no build step.

The loop:

1. Open the canvas and pick **Editor**. On first open the draft is seeded from the
   current published version, or starts empty for a canvas that has never published.
2. Edit files in the tree. Changes autosave to the draft 700 ms after you stop
   typing; `⌘S` / `Ctrl+S` saves at once.
3. Check the **Preview** pane, or **Open full preview** in a new tab.
4. Choose **Review and publish** (or `⌘↵` / `Ctrl+Enter`). Any unsaved edit is saved
   first. Review added, changed and removed files, the home page and who can open it.
5. Choose **Publish canvas** or **Publish update** in the review. The draft becomes
   a new immutable version at the same link. The toast names it: `Published version 7`.

Editors get the same tab and the same controls as the owner (see
[Roles: viewers and editors](/docs/authoring/sharing#roles-viewers-and-editors)).
Agents run the same loop over MCP with `get_draft`, `read_draft_file`,
`write_draft_file`, `rename_draft_file`, `delete_draft_file`, `publish_draft`, and
`restore_draft` (see [MCP server](/docs/agents/mcp)).

## Draft and published version

Every canvas has exactly one **draft**: a working copy separate from the version
viewers see. Saving changes the draft only; the canvas URL keeps serving the current
version until you publish.

Autosave runs 700 ms after you stop typing, with a final flush when you leave the
editor or switch files. `⌘S` / `Ctrl+S` in the code editor saves at once. The status
line in the bar above the editor tells you where your edit is, in this order of
precedence:

| Status | Meaning |
|---|---|
| **Saving...** | A save is in flight. |
| **Save conflict** | Someone else saved this file first. See [Two people, one file](#two-people-one-file). |
| **Save failed** | The save errored. Your text stays in the editor; edit again or publish to retry (publishing saves first). |
| **Unsaved changes** | The edit is still in the autosave window. |
| **Unpublished changes** | The draft is saved and differs from the published version. |
| **Behind the published version** | The draft has no edits of its own, but a direct deploy moved the live version under it. See [When a direct deploy lands](#when-a-direct-deploy-lands). |
| **All changes published** | Draft and published version match. |

Whenever the draft is behind, a separate **A newer version was published** notice sits
next to the status line, whatever else the status says.

**Review and publish** is enabled when the draft has at least one file and something to ship:
unpublished changes, an unsaved edit, or a draft that is behind. When it is disabled,
its tooltip says why: **The published version already matches this draft**, or **Add
a file to the draft before publishing**. The `⌘↵` shortcut uses the same gate and is
ignored while a dialog (Add file, Rename, Delete) is open.

The review checks the saved draft and access again when you confirm. If either changed,
it shows the updated details and asks you to review again. A failed refresh blocks
publishing; a save conflict keeps your text in the editor. If publishing is not
confirmed, check **Versions** before retrying. Review does not lock other editors
out: the existing publish endpoint snapshots the saved draft when it executes.

Publishing snapshots the draft's file list into a new immutable version, points the
canvas at it, and prunes history beyond the last **10** versions. Files are already
stored as you edit, so publishing writes no bytes, only the manifest and the pointer.
A save that lands while a publish is running is kept as new unpublished work, not
erased. When the canvas's preview mode is **auto** and the instance has
[screenshots](/docs/self-hosting/screenshots) on, a fresh cover is captured after each
publish.

The **Upload and publish** / **Upload new version** button in the canvas header is a different thing: it
uploads files (paste, folder, or ZIP) as a direct deploy. The editor and the unpublished Share view use
**Review and publish** to publish the saved draft.

### When a direct deploy lands

Direct deploys (folder, ZIP, paste, the Deploy API, MCP `deploy_canvas`) publish a
version without going through the draft. Afterwards the server reconciles the draft
against what was just deployed:

| Draft before the deploy | After the deploy |
|---|---|
| No draft yet | A draft is created from the new version. |
| Draft matches the version it was seeded from (no real edits) | The draft is replaced with the new version; nothing to lose. |
| Draft has unpublished edits | The edits are kept and the draft is flagged: **A newer version was published**. |

In the flagged case, Publish stays enabled and would replace that newer version with
your draft's content (the newer version stays in history). To build on the newer
version instead, open **Versions** and **Restore** it into the draft, then reapply
your edits.

### Archived and disabled canvases

The Editor tab shows **Editing is paused** while a canvas is archived or disabled by an
admin: no edits, no publish. **Unarchive** from the canvas header to resume. On an
archived canvas the Versions tab still lets you **Download ZIP**, **Restore** a version
into the draft, and **Delete** a non-current version; **Make current** is hidden and
publishing returns `409 NOT_ACTIVE` until the canvas is active again. A disabled canvas
is read-only throughout: every draft write, restore, rollback, and version deletion
returns `409 DISABLED`, and the Versions tab shows **Read-only while disabled**.

## Two people, one file

The owner and every editor can work on the same draft at once. Saves are checked per
file: each save carries the content hash the editor last loaded, and the server
refuses a save whose file changed underneath it (`409 DRAFT_CONFLICT`, naming who
saved and when). Edits to different files merge without any of this.

On a conflict the editor keeps your text and shows the other person's saved version
beside it under **Someone else saved `path` first**, with three choices:

- **Use their version**: your buffer becomes theirs.
- **Overwrite with mine**: re-save your buffer over theirs. The save is pinned to the
  version you just saw, so a third change in between is still caught.
- **Copy my version**: copy your buffer to the clipboard and decide later.

The conflicted file does not autosave until you choose. Uploading a file over a path
someone else changed is refused the same way; the draft is refreshed so a second
upload carries the current hash.

If your access changes mid-session (you were removed, demoted to viewer, or left the
org), the server stops accepting saves from that session and the editor shows **You no
longer have edit access to this canvas**. Your unsaved edits stay on screen with
**Copy my edits** and **Download my edits** until you leave.

## Files

The **Files** pane covers **Add file**, **Upload files** (or drag files onto the pane),
rename, delete, replace, and download. Paths are relative to the canvas root and stored
as written, so `css/site.css` and `<link href="css/site.css">` line up. Folders start
collapsed; expand the branch you need. Adding or renaming onto an existing path is
refused rather than overwriting it (`PATH_EXISTS`); dotfiles and absolute paths are
rejected (`INVALID_PATH`), and a `..` segment is rejected (`ZIP_SLIP_REJECTED`).

Text files on the editable allowlist (HTML, CSS, JS/TS, JSON, Markdown, SVG, XML, CSV,
YAML, TOML, plain text, and similar) up to **2 MB** open in the code editor
(CodeMirror) with syntax highlighting. Everything else, including images, fonts,
spreadsheets, and larger text files, is a non-editable asset: images preview inline,
and any such file offers **Download** and **Replace**.

Limits per canvas: **25 MB per file** (`FILE_TOO_LARGE`), **100 MB total**
(`CANVAS_TOO_LARGE`), **2,000 files** (`TOO_MANY_FILES`). A save that would cross a
limit is rejected with the reason. A text file that looks like it embeds a canvas API
key is saved but logged as a warning on the server; keys belong server-side only.

### The root page

Name your home page `index.html` at the canvas root. Resolution at the canvas URL:

- `index.html` exists: it is the root page. A folder request such as `docs/` serves
  `docs/index.html`.
- No `index.html` but exactly one HTML file: that file is served at the root,
  whatever its name.
- Several HTML files and no `index.html`: the root returns 404, because there is no
  way to pick the home page.

With **Single-page app mode** on (Settings, URL & routing), any unmatched path serves
the same root page, so client-side routes survive a reload.

The editor flags each state above the tree: **No HTML page in this draft** (with
**Add index.html**), **Home page is inferred** (with **Rename to index.html**), and
**Choose the root page** (select the intended page, then **Rename selected**). Publish
is not blocked by these, but a canvas with no root page returns 404 at its URL.

## Preview

The **Preview** pane renders the whole draft site from its root page, not the selected
file, so what you see is what publishing would ship. Refresh, full screen (Escape
exits), hide, and **Open full preview** in a new tab sit in the pane header.

The inline pane runs the draft in a sandboxed frame (`allow-scripts allow-forms`, no
`allow-same-origin`), which keeps draft code away from your dashboard session. Static
HTML, CSS, and images render faithfully there. ES modules, signed-in SDK calls
(`canvasdrop.me()`, `kv`, `files`, `ai`, `realtime`), and self-hosted fonts do not work
inside the sandbox, so a draft that contains JavaScript files starts on the notice
**This canvas runs JavaScript** with two options: **Run preview** (load it in the
sandbox anyway; plain inline scripts run) or **Open full preview** (a top-level tab
where everything runs as it ships).

The preview is served from the dashboard origin at `/api/canvases/{id}/preview/` and
only to the owner and editors; anyone else, admins included, gets 404. The public
canvas URL never serves draft content.

## Page text mode

For a single static page you can edit copy directly on the rendered page instead of
in the source. Switch the mode control from **Code** to **Page text**, then click any
text to edit it. A small toolbar on selection covers bold, italic, underline,
strikethrough, heading levels (H1, H2, Body, Quote), bulleted and numbered lists,
link, unlink, and clear formatting. Edits save back to that HTML file through the same
autosave and conflict checks as the code editor.

**Page text** is offered only when the draft has exactly one HTML file and no
JavaScript files. Other assets (CSS, images) are fine. Drafts with zero or several
HTML pages, or with script files, use **Code**; the mode control's tooltip names the
condition that is not met. If a draft stops qualifying while you are in Page text,
the editor returns to Code.

## Versions

Each publish, and each direct deploy, is an immutable version. canvas-drop keeps the
last **10** per canvas.

The **Versions** tab lists them newest first with the source (`editor`, folder upload,
ZIP, paste, the API, or `upload` for the staged upload API), who created it, when, file
count, and total size. Per version:

- **Download ZIP**: every file in that version as one archive, named
  `{slug}-v{version}.zip`.
- **Restore to draft**: load that version's files into the draft. Every restore asks
  you to **Replace draft**, because this discards any unpublished draft changes.
  The live canvas stays as it is. The editor opens so you can review before publishing.
- **Make current**: point the canvas URL at that version, older or newer, for all
  visitors immediately, after a confirmation. This is the roll back (and roll
  forward) control.
- **Delete**: remove a non-current version from history after confirmation. The
  current version cannot be deleted (`409 CURRENT_VERSION`); files still used by
  another version or the draft are kept.

Restore changes only the draft; Make current changes only what visitors see. To
inspect a single file from an older version, restore it into the draft and use the
tree, or download the ZIP.

Storage is content-addressed: each file is stored once per canvas by content hash, so
a version that changes one file writes one new blob, and blobs no version or the
draft references are swept after publishes and deletions.

## The draft over HTTP

The editor talks to these same-origin routes with your dashboard session. Every one
needs the owner or editor role; a canvas you hold no role on reads 404.

| Route | What it does |
|---|---|
| `GET /api/canvases/{id}/draft` | Draft view: `files[]` (path, size, mime, hash, last writer), `dirty`, `stale`, `baseVersionId`, `changes[]` (path and added/modified/deleted kind), and home-page `entry`. Creates the draft on first call. |
| `GET /api/canvases/{id}/draft/file?path=` | Raw bytes of one draft file. |
| `PUT /api/canvases/{id}/draft/file?path=` | Write or replace a file (raw body). `?mode=create` refuses an existing path. Send `If-Draft-File-Hash` with the hash you loaded (`none` for a new path) to get `409 DRAFT_CONFLICT` instead of overwriting. |
| `DELETE /api/canvases/{id}/draft/file?path=` | Remove a file. Same precondition header. |
| `POST /api/canvases/{id}/draft/rename` | `{from, to}`. Refuses an existing target (`PATH_EXISTS`). |
| `POST /api/canvases/{id}/publish` | New version from the draft: `{version, versionId, fileCount, totalBytes}`. `EMPTY_DEPLOY` on an empty draft; `409 NOT_ACTIVE` when archived. |
| `POST /api/canvases/{id}/restore` | `{version}`. Copies that version's files into the draft. |
| `GET /api/canvases/{id}/preview/{path}` | The draft as a site (used by the Preview pane). |

See also [Create & publish](/docs/authoring/create-and-publish) for the direct deploy
paths (folder, ZIP, paste, Deploy API) and [Sharing & access](/docs/authoring/sharing)
for adding editors.
