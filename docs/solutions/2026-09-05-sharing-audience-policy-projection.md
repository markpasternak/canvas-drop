---
title: Describe the effective link audience with the serving policy
type: improvement
area: sharing
date: 2026-09-05
---

A public_link access value records the selected rung, not whether public sharing is currently available. The instance can pause public links and the owner can lose permission independently. Editors' own publish permissions do not control the canvas's public availability.

Use resolvePublicLinkEnabled for serving and the single-canvas HTTP/MCP projections. Keep lifecycle, password and expiry separate. An older payload without the additive field must say availability is unverified, rather than assume either enabled or paused. Avoid adding policy lookups to library lists.

The summary describes the people-and-teams list without claiming an empty list means only the owner has access; pending invitations are not grants. The parent canvas route already unmounts child views when a refresh fails. Keep that error guard when moving audience components. Schedule an expiry update so the description changes while the reader leaves the page open.

Validation covers global/owner policy, editor identity, legacy Restricted aliases, org scope, missing metadata, lifecycle, password and the expiry boundary. Public availability remains explanatory metadata; authorization still uses the shared server policy.
