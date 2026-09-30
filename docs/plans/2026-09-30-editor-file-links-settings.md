# Editor file URLs and canvas settings polish

## Goal
Show the URL for the file selected in the canvas editor and open its published copy. Make canvas settings easier to scan and navigate on desktop and mobile while retaining the existing design and controls.

## Requirements
- Display the selected file's published URL and copy/open controls. Encode file names correctly in path and subdomain deployments.
- Check the current published manifest: distinguish published, changed draft, new draft file, and offline canvas. Never present a new draft file as live.
- Reuse the live-manifest read path for dashboard and MCP. Add file URLs to existing MCP readback metadata; no new mutation capability.
- Keep existing autosave, draft conflicts, permissions and publishing unchanged.
- Improve settings hierarchy, control grouping, readable help, mobile section navigation, and separation of routine actions from offline/delete actions.
- Preserve current sharing, backend policies, lifecycle confirmation and owner-only actions.

## Implementation units
1. Published file listing with URLs, dashboard query and editor file-location strip; regression tests across HTTP, MCP and editor.
2. Settings layout and responsive section navigation; existing behavior tests plus browser verification.

## Verification and delivery
Run lint, typecheck and the complete dual-dialect/dashboard suite, then build. Review the complete diff sequentially in the main thread as requested. Verify desktop/mobile rendering. Push a feature branch, require green CI, squash merge, back up production, deploy main, verify live behavior and health, then remove the merged worktree/branch.
