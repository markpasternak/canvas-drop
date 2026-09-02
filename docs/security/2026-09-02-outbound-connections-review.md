---
title: Security review — admin-granted outbound Connections
date: 2026-09-02
scope: destination control, DNS pinning, secret handling, runtime authorization, resource bounds
principle: fixed authority profiles; no canvas-selected origins or executable backend code
---

# Outbound Connections security review

## Posture

Connections adds bounded outbound authority without widening the five hard product
invariants. An administrator—not canvas code—chooses one exact HTTPS DNS origin, allowed
methods, and protected headers, then grants the profile to individual canvases. The
canvas runtime is still authenticated and authorized through the existing per-request
pipeline, and Public links remain static-only.

No unresolved invariant break was found in the implemented surface. The intentional
residual risks are the approved upstream reflecting a credential in its response body and
the first release's in-process rate/concurrency coordination. Operators should use
least-privilege upstream credentials and network-level egress restrictions as defense in
depth.

## Controls and evidence

| Boundary | Control | Evidence |
| --- | --- | --- |
| Destination | Profile accepts one exact HTTPS DNS origin with no credentials, path, query, fragment, or IP literal. Runtime accepts only root-relative paths. | Address-policy and validation tests. |
| DNS rebinding | Every answer must be public; mixed answers fail. The chosen address is pinned into the socket while TLS validates the approved hostname. Every redirect re-resolves. | Transport tests with injected DNS and socket lookup. |
| Redirects | Only exact-origin redirects are followed. Redirect method rewriting is rechecked against the admin method allowlist. | Redirect/method transport tests. |
| Secrets | Protected header values are AES-256-GCM encrypted with random IV and profile-id AAD, write-only in APIs/UI, and added after caller headers. Missing/wrong keys fail closed. | Cipher tamper/AAD tests, admin/API projection tests, runtime header tests. |
| Authorization | Existing identity, canvas access, password, lifecycle, same-canvas origin, static-only, broad rate, and Backend gates run before outbound work. Grant/profile state resolves live per request. | Dual-dialect runtime tests with a zero-call injected transport on rejection. |
| Resources | URL/header/request/response/deadline/redirect/rate/concurrency limits are configured centrally; admissions release in `finally`. | Boundary, timeout, cancellation, and limiter tests. |
| Observability | Mutations are audited. Runtime events keep canvas/actor/profile/key/method/outcome/status/latency/byte counts only—never path, query, body, or headers. | Repository/admin-route sanitization tests. |
| Recovery | Backups include profile ciphertext and grants; the root encryption key remains external. | Dual-dialect backup/restore round-trip and operations runbook. |

## Review decisions

- Do not allow wildcard origins, arbitrary URLs, canvas-owned credentials, custom CA
  trust, decompression, cross-origin redirects, or server-supplied code.
- Do not return protected values after a write, including to admins or MCP clients.
- Do not treat application SSRF checks as the only egress boundary in production.
- Do not record requested paths or queries: stock symbols may be benign, but provider
  APIs commonly put credentials and user data there.

