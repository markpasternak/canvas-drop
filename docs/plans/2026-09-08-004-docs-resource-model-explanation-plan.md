---
title: Explain primitives, resources and permissions before deployment
execution: code
---

> Completed in PR #117 (`048f1ed`). On 8 September 2026 the user explicitly
> authorized merge, deployment and canvas migration, including the admin merge
> override. This supersedes the original no-merge/no-deploy boundary below.
> See [rollout verification](../solutions/2026-09-08-runtime-permissions-rollout.md).


Update the existing PR #117 without merging or deploying. Explain that a primitive
is a backend feature, a resource is a named group within it, and permissions are
settings attached to that resource. A collection groups authored records; its name
and membership are independent of its policy. Different collections may use the
same or different policies. Defaults initialize new resources only.

Introduce Data storage on the existing SDK KV page and navigation, retaining all
URLs and API names. Explain when to use shared values, private preferences and
collections, and place the collection SDK reference on that page. Preserve the
old permissions-page anchor with a link. Cross-link capabilities, SDK overview,
files, realtime, runtime API, README and examples. Keep the specification and
agent-facing generated docs aligned. Clarify resource-to-feature mapping in the
Backend form without changing authorization or redesigning its controls.

Validate generated docs and links, lint, typecheck, tests and build. Inspect the
served local docs and Backend form, refresh the user's local preview, then update
the same PR through green CI. No production changes.
