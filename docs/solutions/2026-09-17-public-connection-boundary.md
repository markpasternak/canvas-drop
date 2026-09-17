---
title: Public Connections need a separate runtime boundary
date: 2026-09-17
category: security-and-runtime
---

Public sharing and the viewers Connection audience do not themselves grant
anonymous backend access. An explicit administrator policy on the canvas/profile
grant is the only exception to the static-only runtime guard. Identity and the
other primitives stay closed; status is a separate minimal SDK call.

Two implementation details matter:

- Hono decodes `req.path`. Public endpoint checks must use the original URL
  pathname, reject encoded/query paths, and disable redirects. Preserve existing
  signed-in path handling separately.
- A transport timeout starts after the request body arrives. Public body reads
  need their own deadline, cancellation, and admission accounting, otherwise a
  few unfinished uploads occupy every shared connection slot without spending
  the daily budget. The regression test uses an unfinished stream, then verifies
  the slot was released and the admitted attempt counted.

The daily counter uses one revision-guarded conditional database update, tested
on SQLite and Postgres. Editing or disabling a policy preserves that day's count;
replacing its revision invalidates pending admissions. The migration leaves all
existing grants closed to public access.

Status does not decrypt credentials. Missing, non-public, and unavailable grants
return the same unavailable projection to public visitors. Permission status does
not reserve capacity: invocation still checks the live policy and request limits.

When a canvas adopts `connections.status`, version its SDK URL. The stable SDK
URL may otherwise remain cached in returning visitors' browsers.
