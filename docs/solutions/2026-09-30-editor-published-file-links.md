---
title: Published file links in the editor must follow the live manifest
area: editor
type: feature
date: 2026-09-30
---

The editor's file tree represents a draft. A URL built from that tree can point at a file that has never been published; SPA fallback can even return the home page and disguise that mistake.

Resolve published existence and hashes through `liveManifest`, behind the existing owner/editor management gate. Use `manifestFiles` to add segment-encoded browser URLs to both dashboard metadata and MCP readback. Keep new draft files copyable, but offer Open only for a file in the current published manifest on an active canvas. Explain when draft content differs from the live file.

Key the dashboard query by publication identity and canvas address as well as canvas id, and retain the canvas-query prefix so publish, rollback, slug changes and lifecycle invalidations refresh it. Never derive file availability from an unauthenticated HTTP probe: protected canvases return sign-in HTML.

Coverage: owner/editor readback and viewer/non-member refusal on both database dialects, unpublish clearing the manifest, segment encoding in path/subdomain deployments, MCP URL parity, and editor new-file/changed-file states.
