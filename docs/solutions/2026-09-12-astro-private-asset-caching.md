---
title: Recognize generated Astro names without widening cache access
area: serving
type: performance
date: 2026-09-12
---

The roadmap HAR showed generated Astro bundles revalidating because the filename
classifier recognized hexadecimal hashes only. Astro's observed eight-character
URL-safe base64 suffixes now use the existing immutable policy when they occur
under `_astro/`, include an uppercase character and have a generated asset extension.
Ambiguous lowercase non-hex suffixes retain revalidation. The existing hexadecimal
rule remains unchanged.

Classification must never decide who can see a file. `canvasAccess` still runs before
`serveCanvas`; `canvasCacheControl` still assigns private scope to restricted assets.
The assembled-app tests cover both URL modes, anonymous and ungranted readers,
access removal after warmup, conditional requests, password protection, expiry and
lifecycle restrictions. A serving helper with an injected authorized context cannot
prove those middleware boundaries.

The naming rule is a publisher convention, not proof that a hash is authentic.
Never publish different bytes at the same recognized URL. Private browser caches
can retain downloaded bytes after logout or access removal; reverting server headers
does not purge those responses. A content correction needs a new URL.

The independent review also caught a misleading public-to-restricted warning: it
quoted the HTML TTL while public hashed assets could remain shared-cacheable for
a year, including with HTML edge caching disabled. The shared warning helper now
explains both windows for dashboard and MCP callers. Cache headers are unchanged.

The combined release plan is
[resource serving performance](../plans/2026-09-12-2303-fix-resource-serving-performance-plan.md).
Tracking issue #121 holds CI, deployed revision and measurement receipts. The roadmap
Go API and Canvas Drop server are independent releases; a static canvas publish does
not deploy either service.
