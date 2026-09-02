# The editor

Change a canvas's files in the browser, check the result, and publish when you are
ready. Nothing viewers see changes until you publish. The editor is the **Editor**
tab of any canvas you own or edit; there is no local setup and no build step.

The loop:

1. Open the canvas and pick **Editor**. On first open the draft is seeded from the
   current published version, or starts empty for a canvas that has never published.
2. Edit files in the tree. Changes autosave to the draft.
3. Check the **Preview** pane, or open the full preview in a new tab.
4. Press **Publish** (or `⌘↵` / `Ctrl+Enter`). The draft becomes a new immutable
   version and the canvas URL serves it immediately.

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
editor. `⌘S` / `Ctrl+S` in the code editor saves at once. The status line in the bar
above the editor tells you where your edit is:

| Status | Meaning |
|---|---|
| **Unsaved changes** | The edit is still in the autosave window. |
| **Saving...** | A save is in flight. |
| **Save failed** | The save errored. Your text stays in the editor; edit again or publish to retry (publishing saves first). |
| **Save conflict** | Someone else saved this file first. See [Two people, one file](#two-people-one-file). |
| **Unpublished changes** | The draft is saved and differs from the published version. |
| **A newer version was published** | A direct deploy moved the live version under your draft. See [When the draft is stale](#when-the-draft-is-stale). |
| **All changes published** | Draft and published version match. |

**Publish** is enabled when the draft has at least one file and something to ship:
unpublished changes, an unsaved edit, or a stale draft. When it is disabled, its
tooltip says why: the published version already matches the draft, or the draft has
no files yet.

Publishing snapshots the draft's file list into a new `ready` version, points the
canvas at it, and prunes history beyond the last **10** versions. A save that lands
while a publish is running is kept as new unpublished work, not erased. When the
canvas's preview mode is set to auto and the instance has
[screenshots](/docs/self-hosting/screenshots) on, a fresh cover is captured after
each publish.

### When the draft is stale

Direct deploys (folder, ZIP, paste, the deploy API, MCP `deploy_canvas`) publish a
version without touching the draft. When one lands while you have a draft, the bar
shows **A newer version was published**. Publish stays enabled and would replace that
newer version with your draft's content (the newer version stays in history). To
build on it instead, open **Versions** and **Restore** it into the draft.

### Archived and disabled canvases

The Editor tab is paused while a canvas is archived or disabled by an admin: no
edits, no publish. Unarchive from the canvas header to resume. On an archived canvas
the Versions tab still lets you download a version's ZIP or restore one into the
draft; publishing and **Make current** return `409 NOT_ACTIVE` until the canvas is
active again. A disabled canvas is read-only throughout (`409 DISABLED` on any write).

## Two people, one file

The owner and every editor can work on the same draft at once. Saves are checked per
file: each save carries the content hash the editor last loaded, and the server
refuses a save whose file changed underneath it (`409 DRAFT_CONFLICT`). Edits to
different files merge without any of this.

On a conflict the editor keeps your text and shows the other person's saved version
beside it, with three choices: **Use their version** (your buffer becomes theirs),
**Overwrite with mine** (re-save your buffer over theirs), or **Copy my version** to
the clipboard. The conflicted file does not autosave until you choose.

If your access changes mid-session (you were removed or demoted, or you tried an
owner-only action), the server stops accepting saves from that session and the editor
shows a lock-out notice. Your unsaved edits stay on screen with **Copy my edits** and
**Download my edits** until you leave.

## Files

The file tree covers add, upload, drag-and-drop, rename, delete, replace, and
download. Paths are stored as written, so `css/site.css` and
`<link href="css/site.css">` line up. Folders start collapsed; expand the branch you
need. Adding or renaming onto an existing path is refused rather than overwriting it,
and dotfiles, absolute paths, and `..` segments are rejected.

Text files on the editable allowlist (HTML, CSS, JS/TS, JSON, Markdown, SVG, CSV,
YAML, and similar) up to **2 MB** open in the code editor (CodeMirror) with syntax
highlighting. Everything else, including images, fonts, spreadsheets, and larger text
files, is a non-editable asset: images preview inline, and any such file offers
**Download** and **Replace**.

Limits per canvas: **25 MB per file**, **100 MB total**, **2,000 files**. A save
that would cross a limit is rejected with the reason.

### The root page

Name your home page `index.html` at the canvas root. Resolution at the canvas URL:

- `index.html` exists: it is the root page. A folder request such as `docs/` serves
  `docs/index.html`.
- No `index.html` but exactly one HTML file: that file is served at the root,
  whatever its name.
- Several HTML files and no `index.html`: the root returns 404, because there is no
  way to pick the home page.

With **SPA fallback** on (Settings, URL & routing), any unmatched path serves the same
root page, so client-side routes survive a reload.

The editor flags each state above the tree: **No HTML page in this draft** (with
**Add index.html**), **Home page is inferred** (with **Rename to index.html**), and
**Choose the root page** (select the intended page, then rename it). Publish is not
blocked by these, but a canvas with no root page returns 404 at its URL.

## Preview

The **Preview** pane renders the whole draft site from its root page, not the selected
file, so what you see is what publishing would ship. Refresh, full screen (Escape
exits), hide, and **Open full preview** in a new tab sit in the pane header.

The inline pane runs the draft in a sandboxed frame with an opaque origin, which keeps
draft code away from your dashboard session. Static HTML, CSS, and images render
faithfully there. ES modules, signed-in SDK calls (`canvasdrop.me()`, `kv`, `files`,
`ai`, `realtime`), and self-hosted fonts do not work inside the sandbox, so a draft
that contains JavaScript files starts on a notice with two options: **Run preview**
(load it in the sandbox anyway; plain inline scripts run) or **Open full preview** (a
top-level tab where everything runs as it ships).

The preview is served from the dashboard origin at `/api/canvases/{id}/preview/` and
only to the owner and editors. The public canvas URL never serves draft content.

## Page text mode

For a single static page you can edit copy directly on the rendered page instead of
in the source. Switch the mode control from **Code** to **Page text**, then click any
text to edit it; a small toolbar on selection covers bold, italic, and links. Edits
save back to that HTML file through the same autosave and conflict checks as the code
editor.

**Page text** is offered only when the draft has exactly one HTML file and no
JavaScript files. Other assets (CSS, images) are fine. Drafts with zero or several
HTML pages, or with script files, use **Code**; the mode control's tooltip names the
condition that is not met. If a draft stops qualifying while you are in Page text,
the editor returns to Code.

## Versions

Each publish, and each direct deploy, is an immutable version. canvas-drop keeps the
last **10** per canvas.

The **Versions** tab lists them newest first with the source (editor, folder upload,
ZIP, paste, the API, or a staged upload), who published it, when, file count, and
total size. Per version:

- **Download ZIP**: every file in that version as one archive.
- **Restore**: load that version's files into the draft. If the draft has unpublished
  changes, canvas-drop asks first (**Load and discard changes**). The published
  version is untouched until you publish.
- **Make current**: point the canvas URL at that version, older or newer, for all
  visitors immediately. This is the roll back (and roll forward) control.
- **Delete**: remove a non-current version from history after confirmation. The
  current version cannot be deleted; files still used by another version or the
  draft are kept.

Restore changes only the draft; Make current changes only what visitors see. To
inspect a single file from an older version, restore it into the draft and use the
tree, or download the ZIP.

Storage is content-addressed: each file is stored once per canvas by content hash, so
a version that changes one file writes one new blob, and blobs no version or the
draft references are swept after publishes and deletions.

See also [Create & publish](/docs/authoring/create-and-publish) for the direct deploy
paths (folder, ZIP, paste, deploy API) and [Sharing & access](/docs/authoring/sharing)
for adding editors.
