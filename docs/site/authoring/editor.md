# The editor

Edit a canvas's files in the browser, preview your changes, then publish when
ready — no local setup, no build step. The editor lives in the canvas's **Editor**
tab.

## Drafts and publishing

Every canvas has one **draft**: a working copy separate from what viewers see.
When you open a new canvas's draft it starts empty; otherwise it's seeded from the
current published version. Your edits autosave to the draft as you go (debounced,
with a final flush when you leave the editor); the canvas keeps serving its published
version until you explicitly **publish**.

The loop:

- Edit files in the draft. Changes autosave; nothing viewers see changes yet.
- **Preview** the draft to check it before publishing.
- **Publish** when ready. This snapshots the draft into a new immutable version and
  points the canvas at it.

## Files

Use the file tree to add, rename, replace, delete, and upload files (drag-and-drop
works too). Relative paths are preserved, so a `css/site.css` reference resolves
the way you'd expect.

Name your home page `index.html` at the canvas root. The root URL serves `index.html`
if it exists; if the draft has exactly one HTML file it's served as the entry even
under another name; but with multiple HTML files and no `index.html`, the canvas root
returns 404. Drafts in that state get a repair notice pointing you toward a valid
`index.html`.

Text files open in the CodeMirror editor with syntax highlighting. Binary assets
(images, fonts, spreadsheets) aren't text-editable: images show a preview, and any
non-editable file offers **Download** and **Replace** instead of an edit surface.
You can publish any non-empty draft.

## Preview and on-page editing

The live preview pane (owner-only, collapsible and expandable to fullscreen) renders
the current draft, not the published version, so you see exactly what publishing would
ship. For JavaScript-driven drafts the inline pane can't run ES modules or make
authenticated SDK calls, so it swaps to an **Open full preview** link that opens the
draft in its own context.

Two editing surfaces:

- **Code** (CodeMirror) — the default, available for any draft.
- **Page text** — edit the copy directly in the rendered page; it saves back to that
  HTML file. Available only when the draft is a single HTML page with no JavaScript.
  Anything else (multiple HTML files, or a page that runs JavaScript) uses Code mode,
  and the editor falls back to Code automatically if on-page editing stops being
  available.

## Versions, rollback, and restore

Each publish is an immutable version. canvas-drop keeps the **last 10** versions;
older ones are pruned.

From the **Versions** tab you can:

- See version history with the source (editor, folder, ZIP, paste, the deploy
  API, or a staged upload), when it was published, file count, and total size.
- Make any version the served one with the **Make current** button (confirm in the
  dialog). It re-points the canvas to that version — forward or back — as a guarded
  pointer swap, so visitors get it immediately.

To pick up editing from an earlier version, use **Edit this version**: it loads a
published version back into the draft so you can change it and publish again. If the
draft already has unpublished changes, you're prompted to confirm before they're
discarded. Making a version current changes what visitors see; editing a version
changes what's in your draft.

Storage is content-addressed: files are keyed by content hash, so unchanged files
across versions are stored once and only changed files are written.

See also [Create & publish](/docs/authoring/create-and-publish) for the non-editor
paths (folder, ZIP, paste, deploy API).
