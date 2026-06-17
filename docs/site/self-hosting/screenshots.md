# Screenshots (canvas previews)

canvas-drop can capture a **preview screenshot of each published canvas** and reuse it
as the gallery cover and — for public canvases — the link-unfurl (Open Graph) image.
It's an optional, off-by-default extra: when it's off, the product behaves exactly as
it always has (gallery shows generative-art covers, links unfurl with the branded
`/og.png`).

**Where previews appear today:** the **gallery** cover and the **public-link OG** image.
The capture itself is stored once per canvas as a private, access-gated asset, so the
same image can back additional surfaces (e.g. dashboard thumbnails) without re-capturing
— those are wired in as the product decides to surface them.

## How it works

- **Captured on publish.** Publishing a canvas (editor publish or any deploy) schedules
  a capture. Capture is asynchronous — it never slows down or blocks a publish.
- **One preview per canvas.** A canvas has exactly one current preview, stored as WebP
  renditions (`og`, `card`, `thumb`) and **overwritten** on each republish. The image
  always reflects the latest published version.
- **One browser, a small queue.** A single headless Chromium runs in the server process
  and is reused across captures (a fresh, isolated browser context per job, recycled
  periodically). Jobs are drained from a small database queue one at a time by default
  (`CANVAS_DROP_SCREENSHOTS_CONCURRENCY`), so a burst of publishes just queues up.
- **Private by default.** Previews are stored privately and served through an
  **access-gated** route: a canvas's preview is only served to someone already allowed
  to see that canvas. Private/gated canvas previews are **never** exposed publicly — a
  per-canvas OG image is emitted only for `public_link` canvases.
- **Capture is sandboxed.** While a canvas is being captured, its backend primitives
  (AI, realtime, network) are neutered — a capture makes no AI spend and no outbound
  network calls. Dialogs are dismissed and a hard timeout bounds a slow/looping canvas.

## Enablement — two layers, no per-user opt-out

The feature only runs when **both** layers say yes; there is no per-user or per-canvas
opt-out (it's an org-wide capability):

1. **Environment availability** — `CANVAS_DROP_SCREENSHOTS` must be `on`, **and** the
   runtime image must actually contain Chromium (see below). This is the operator's
   "is this capability available at all" switch. Default: `off`.
2. **Admin runtime toggle** — even when available, an admin must turn it **on** in the
   dashboard (Admin → Configuration → *Screenshots enabled*). Default: **off**.

When either layer is off, **no browser is launched** and previews are not served — the
gallery and link unfurls behave exactly as they do today.

## Turning it on

### 1. Build an image that includes Chromium

The default image does **not** include Chromium (it would add ~300 MB, and the feature
ships disabled). Build with the opt-in build arg:

```sh
docker build --build-arg SCREENSHOTS=1 -t canvas-drop:screenshots .
```

This installs Chromium and its system libraries into the image. The default build
(`SCREENSHOTS=0`) skips this entirely and stays lean.

### 2. Make it available in the environment

Set the env flag on the running container/instance:

```sh
CANVAS_DROP_SCREENSHOTS=on
```

Optional tuning (all have sensible defaults):

| Variable | Default | What it does |
|---|---|---|
| `CANVAS_DROP_SCREENSHOTS_CONCURRENCY` | `1` | Captures processed at once (one browser, N contexts) |
| `CANVAS_DROP_SCREENSHOTS_TIMEOUT_MS` | `20000` | Hard per-capture wall-clock timeout |
| `CANVAS_DROP_SCREENSHOTS_RECYCLE_EVERY` | `50` | Relaunch the browser after this many jobs |
| `CANVAS_DROP_SCREENSHOTS_LEASE_MS` | `120000` | Job lease (a crashed worker's job is reclaimed after this) |
| `CANVAS_DROP_SCREENSHOTS_MAX_ATTEMPTS` | `3` | Retries before a capture is marked failed |
| `CANVAS_DROP_SCREENSHOTS_FAILED_TTL_MS` | `86400000` | Failed-job rows reclaimed after this |
| `CANVAS_DROP_SCREENSHOTS_TOKEN_TTL_MS` | `60000` | Lifetime of the internal capture credential |

### 3. Flip the admin toggle

Sign in as an admin → **Admin → Configuration** → turn **Screenshots enabled** on.
New publishes start getting previews immediately; existing canvases get one on their
next publish.

## Turning it off

Flip the admin toggle off (or unset `CANVAS_DROP_SCREENSHOTS`). Capture stops and
previews are no longer served — covers revert to generative art and unfurls to the
branded card. Stored previews are harmless and are reclaimed when a canvas is deleted.

## Memory note

Chromium is memory-heavy. On a small single-VPS deployment, keep concurrency at `1`
(the default) and rely on the per-job timeout and periodic browser recycle to bound
memory. Scale concurrency up only if the host has headroom.
