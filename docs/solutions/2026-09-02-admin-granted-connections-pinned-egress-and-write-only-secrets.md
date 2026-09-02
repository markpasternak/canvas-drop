---
title: Admin-granted Connections — pin DNS, project authority, keep secrets write-only
type: architecture
area: runtime
date: 2026-09-02
---

# Admin-granted Connections: bounded authority without a Lambda runtime

The concrete need was to let a canvas fetch third-party data that a browser cannot reach
because of CORS or required server-controlled headers, such as stock data behind a fixed
`User-Agent`. A generic sandboxed function runtime would have introduced code execution,
packaging, dependency, scheduling, isolation, and abuse-control systems. A reusable,
admin-granted request profile satisfies the need with a much smaller authority surface.

## Bind authority before accepting request data

The profile owns the exact HTTPS DNS origin, allowed methods, and protected headers. A
canvas grant refers to that profile; the page supplies only a root-relative path/query,
body, and bounded non-protected headers. Protected headers are applied last. Owners and
editors can inspect the sanitized authority but cannot create, widen, or recover its
credential values.

The manager HTTP route, MCP tool, and dashboard all consume one service projection. That
prevents “secret value accidentally added to one serializer” and keeps profile enabled,
encryption-key availability, grant state, and Backend state aligned across surfaces.

## DNS validation is not DNS pinning

Resolving a public address and then letting the HTTP client resolve the hostname again
leaves a rebinding window. The transport therefore resolves every hop itself, rejects the
whole answer set if any address is non-public, selects a public address, and injects that
address through the request socket's lookup callback. The original hostname remains the
TLS SNI, certificate, and Host authority.

One Node `net.BlockList` containing both IPv4 and IPv6 ranges produced a surprising false
positive: an IPv4-mapped IPv6 rule could match ordinary public IPv4 input. Separate IPv4
and IPv6 block lists made address-family intent explicit and kept mapped-address handling
testable. Preserve those focused tests if the range list changes.

Redirects repeat the same resolution and pinning procedure and must retain the exact
scheme, hostname, and effective port. A redirect that rewrites POST to GET must still be
checked against the profile's method allowlist.

## Browser preflight is part of the primitive

A fetch-like API that accepts safe caller headers is unusable in subdomain mode if CORS
preflight advertises only `Content-Type`. The pre-gateway OPTIONS handler now allows all
supported standard methods and echoes the browser-requested header names only for the
validated canvas origin. The actual runtime route still counts, validates, strips, and
overrides headers; preflight permission is not forwarding permission.

## Keep recovery and telemetry intentionally incomplete

AES-256-GCM envelopes belong in the database and therefore in backups. The root key does
not: it stays in the deployment secret store and must accompany a restore independently.
With the wrong or missing key, protected profiles fail closed while metadata and grants
remain removable. First-release key rotation is replace-in-place re-entry of every
protected header map.

Runtime usage records operational dimensions and byte counts, including rejected keys,
but never paths, query strings, bodies, or headers. A requested URL is tempting debugging
data and an equally tempting credential leak. Mutation audit and request metering remain
separate: grants/profile changes are durable audit events; calls are best-effort,
90-day-bounded usage events.

