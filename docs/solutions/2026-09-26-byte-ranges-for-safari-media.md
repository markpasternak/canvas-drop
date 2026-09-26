---
title: Canvas files must answer byte-range requests, or Safari will not play media
date: 2026-09-26
category: serving
---

A 22 MB MP4 on a public canvas played in Chrome but not in Safari on macOS or iOS.
Canvas serving ignored `Range` and answered every request with the whole file and a
`200`. Chrome falls back to downloading the whole file; Safari opens media with
`Range: bytes=0-1`, expects `206 Partial Content`, and gives up otherwise. Apple
requires byte-range support from any server hosting media for iOS.

`serveCanvas` now advertises `Accept-Ranges: bytes` on every file and answers one
range with `206` and `Content-Range`, including open-ended (`bytes=N-`) and suffix
(`bytes=-N`) ranges. A range starting past the end gets `416` with `bytes */size`. It
serves the whole file for several ranges, a malformed header, or an `If-Range` that
does not match the content-hash ETag, all of which RFC 9110 §14 allows.
`If-None-Match` is evaluated first, so a cached copy still gets `304`.

Caddy's `reverse_proxy` passes `Range` and `206` through unchanged. Its `encode zstd
gzip` only compresses text-like types, so media ranges are not re-encoded.

To check a host by hand, run `curl -sI -H "Range: bytes=0-1" <url>`. Expect `206` and
`content-range: bytes 0-1/<size>`.

The first fix went onto production as an on-box hotfix: the same patch applied to
`/opt/canvas-drop`, with only `apps/server` rebuilt. The next `deploy/setup.sh deploy`
resets the box to `origin/main`, so that hotfix is safe to leave in place until this
change merges.
