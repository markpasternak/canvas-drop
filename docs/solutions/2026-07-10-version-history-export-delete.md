---
title: Version history export and safe deletion share one owner service
type: architecture
area: storage
date: 2026-07-10
---

Version history now supports complete ZIP export and permanent deletion of a
non-current ready version from both the dashboard and MCP. The important seam is
`VersionHistoryService`: management routes and MCP tools delegate to the same owner-level
behavior instead of rebuilding archive or cleanup logic per transport.

## Invariants

- **Deletion protects the live pointer atomically.** The repository delete predicate checks
  canvas id, version number, ready status, and that the row is not the canvas's current version
  in one statement. A route-level read-then-delete check would race a concurrent rollback.
- **Blob deletion is mark-and-sweep, never inline.** After the row is removed, the existing
  canvas blob collector computes the live hashes across every remaining ready version plus the
  draft. A blob shared by another version or the draft survives.
- **ZIP export is all-or-nothing.** Every manifest blob is loaded before the archive is returned.
  A missing blob fails the request rather than producing a plausible but incomplete backup.
- **MCP parity keeps OAuth at the transport boundary.** `list_versions` advertises a download
  URL, while its raw ZIP route accepts only the verified OAuth bearer header and reuses the MCP
  account-lifecycle and rate-limit guard. Query tokens and dashboard cookies are intentionally
  not accepted.
- **Disabled canvases are read-only.** Export remains available; restore, rollback, and deletion
  remain blocked. Archived canvases may still restore or delete history, but cannot change the
  live pointer until unarchived.

Keep direct version actions simple in the UI: Download ZIP, Restore to draft, and Delete for a
non-current historical version. Per-file browsing stays in the editor after Restore.
