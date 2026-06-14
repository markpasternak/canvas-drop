# Runtime API

The runtime API is what the [browser SDK](/docs/sdk/overview) calls from inside a
canvas. You normally use the SDK rather than these endpoints directly, but they're
documented here for completeness.

> **Auth:** the **session cookie**, sent automatically by the browser. Requests are
> credentialed and identity is resolved server-side — the canvas never asserts who
> the viewer is. Each endpoint is gated by its capability; a disabled capability
> returns `CAPABILITY_DISABLED`. (This differs from the Bearer-key
> [Deploy API](/docs/api/deploy-api).)
>
> The SDK script itself, `{base}/sdk/v1.js`, is served to signed-in canvas pages —
> it requires a session, unlike the public deploy API.

Base path: `{base}/v1/c/{slug}`.

## Identity

```
GET {base}/v1/c/{slug}/me        → { id, email, name, avatarUrl }
```

## Key–value

Shared namespace under `/kv`, per-viewer namespace under `/kv/user` (the server
forces the caller's id as scope — never client-supplied).

```
GET    {base}/v1/c/{slug}/kv?prefix=&limit=     list
GET    {base}/v1/c/{slug}/kv/{key}              read (null if absent)
PUT    {base}/v1/c/{slug}/kv/{key}              write
DELETE {base}/v1/c/{slug}/kv/{key}              delete
```

`increment` is exposed as an atomic write on a numeric key. The same paths exist
under `/kv/user/...` for the per-viewer namespace.

## Files

```
POST   {base}/v1/c/{slug}/files                 upload (multipart form, field "file")
GET    {base}/v1/c/{slug}/files                 list
GET    {base}/v1/c/{slug}/files/{id}/content    download (served as attachment)
DELETE {base}/v1/c/{slug}/files/{id}            delete
```

## AI

```
POST   {base}/v1/c/{slug}/ai                    chat completion (SSE stream)
```

The provider key is server-side only; spend is metered per user and per canvas.

## Realtime

```
WS     {base}/v1/c/{slug}/realtime              ephemeral pub/sub + presence
```

## Errors

All endpoints return stable `code` values — see [Error codes](/docs/api/errors).
