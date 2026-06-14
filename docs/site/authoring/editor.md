# The editor

Edit a canvas's files in the browser, preview your changes, then publish when
ready — no local setup, no build step. The editor lives in the canvas's **Editor**
tab.

## Drafts and publishing

Every canvas has one **draft**: a working copy separate from what viewers see.
When you open a new canvas's draft it starts empty; otherwise it's seeded from the
current published version. Your edits autosave to the draft as you go — the canvas
keeps serving its published version until you explicitly **publish**.

The loop:

- Edit files in the draft. Changes autosave; nothing viewers see changes yet.
- **Preview** the draft to check it before publishing.
- **Publish** when ready. This snapshots the draft into a new immutable version and
  points the canvas at it.

## Files

Use the file tree to add, rename, and delete files. `index.html` at the canvas
root is the entry point. Text files open in the editor with syntax highlighting;
binary assets (images, fonts) are supported alongside them.

## Preview and on-page editing

Preview renders the current draft (not the published version), so you see exactly
what publishing would ship. For a draft that is a single HTML page, you can switch
to on-page editing to tweak text directly in the rendered page; multi-page or
JS-rendered drafts edit in code.

## Versions, rollback, and restore

Each publish is an immutable version. canvas-drop keeps the **last 10** versions;
older ones are pruned.

From the **Versions** tab you can:

- See version history with the source (folder, ZIP, paste, or the API), when it was
  published, file count, and total size.
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
