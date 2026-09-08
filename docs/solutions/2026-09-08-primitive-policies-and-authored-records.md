---
title: Resource policies, authored records and defaults
date: 2026-09-08
category: security-and-data-integrity
---

# Resource policies, authored records and defaults

The primitive-policy extension of PR #117 supersedes the earlier runtime model's
fixed audience split. Canvas roles remain owner/editor/viewer; resource policies
decide whether an admitted user may read, create, update, delete or increment.

## Immutable authorship is separate from record content

Records use server-generated IDs and immutable server-derived authors. A JSON
property named `authorId` is content and cannot affect authorization. Updates
never replace attribution. Reserved collection scopes cannot be reached through
raw shared or personal KV. Personal resources exclude managers unless they are
the author; administrative status alone is not a runtime grant.

Apply read filters before pagination. Intersect read and mutation rights, including
bulk deletion. Identity projections use the same rules as enforcement. Atomic
increments check both numeric type and finite range in the SQL update; the PG
cast uses CASE because predicate evaluation order is not a cast safety guarantee.

## Attachment permissions follow the current parent

Attachment URLs reauthorize on every request using the parent's immutable author
and current collection policy. Metadata listing uses batched parent lookups to
avoid a database request per file. A missing parent makes attachment content
inaccessible even if physical cleanup fails. Deletion attempts cleanup and returns
metadata-cleanup failures separately; storage cleanup remains best effort and
logged. An upload rechecks its parent after persistence to catch deletion races.

## Defaults initialize resources; edits use a captured revision

Changing the default never rewrites existing policies. A new resource receives a
concrete preset. The dashboard preserves the policy revision from the first local
edit, including null, across background refetches. Management and MCP require this
revision for an atomic conditional update. A conflict keeps the local edit visible.

## Receiving is a permission too

Realtime separates subscribe, publish, see presence and participate in presence.
Revalidate all recipients before fan-out, not only the sender. Channel messages
carry server attribution and never automatically include private record content.
Connections intersect per-profile audiences/methods with the administrator grant;
an empty method intersection must report `invoke: false` in identity.

## Verification and rollout boundary

Regression tests cover immutable authorship, private manager exclusion, filtered
pagination, bulk rights, finite/concurrent increments, direct file URLs, parent
deletion, live channel revocation and presence, Connection transport rejection,
MCP conditional saves and dashboard default/revision behavior on both databases.
Review is sequential in the main task per the repository tool mapping; no
independent reviewer is claimed. Existing production canvases require deliberate
adaptation before an approved deployment. This work does not migrate their content.

Keep one runtime permission model. Preserve old applications' intent by adapting
their resources, not by retaining a second authorization path or promoting their
viewers to editors. Policy configuration can preserve an existing realtime channel
name, but cannot add per-author enforcement inside a shared KV blob. Migrate those
values into authored records with verified original identities; replaying them
through an owner's runtime session would incorrectly attribute them to that owner.
Preserve record references and attachment associations during the coordinated
cutover. Admin inspection shows the same parsed policies as the management surface
without granting access to private records.
