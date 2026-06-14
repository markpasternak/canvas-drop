# The editor

The in-browser editor lets you create and edit a canvas's files with syntax
highlighting — no local setup, no build step.

## Drafts and publishing

Editing works on a **draft**: a working copy separate from the live version. Your
changes autosave to the draft as you go. The live canvas keeps serving its
published version until you explicitly **publish**.

This gives you a safe place to iterate:

- Edit freely without affecting what viewers see.
- Preview the draft.
- Publish when ready — that creates a new version and points the canvas at it.

## Files

Add, rename, and delete files in the file tree. `index.html` at the root is the
canvas's entry point. Binary assets (images, fonts) are supported alongside text
files.

## Versions

Each publish is a version. From the **Versions** view you can see history and roll
back. Storage is content-addressed, so unchanged files across versions are stored
once.

See also [Create & deploy](/docs/authoring/create-and-deploy) for the non-editor
paths (drag-drop, paste, API).
