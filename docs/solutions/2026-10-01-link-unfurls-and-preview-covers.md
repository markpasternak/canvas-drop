# Link unfurls and preview covers: three traps and the opt-in

Date: 2026-10-01. PRs #133, #134 and the link-preview opt-in.

## Smooth scrolling broke screenshot covers

The capture settle step scrolls the page down to trigger lazy content, then back to
the top before the screenshot. A canvas whose CSS sets `scroll-behavior: smooth`
animates those jumps, so the shot fired mid-scroll and stored a frame of empty page
(the SeenThis roadmap cover was solid background). Every `scrollTo` in
`settleForCapture` now passes `behavior: "instant"`. The opt-in real-Chromium test
(`CANVAS_DROP_TEST_SCREENSHOTS=1`) covers it.

A related limit, by design: capture aborts cross-origin requests and `/v1/` primitive
reads. A canvas that replaces server-rendered content with an error when a live
refresh fails will be captured in that error state. The fix belongs in the canvas, or
the owner uploads a custom cover.

## The unfurler fetches the image too

`socialPreview` answers crawler user agents with an HTML card. The card's `og:image`
is fetched by the same crawler, so any image URL that passes through that middleware
must not be answered with the card again. Image paths and the reserved
`__canvasdrop_preview` path fall through (or get bytes).

## `/og.png` exists only on the base URL

On a canvas subdomain `/og.png` is the canvas's own, gated path. The fallback card
image must be `${baseUrl}/og.png`, never `${requestOrigin}/og.png`.

## Link preview opt-in

A non-public canvas unfurls with the generic sign-in card. The owner or an editor can
set `linkPreview`. A live, published, unexpired canvas then unfurls with its title,
description and custom cover; the cover bytes are served to the signed-out unfurler
from `socialPreview`, since the regular preview route sits behind the access gate. An
automatic screenshot is never exposed, because it can show content. Changes are
audited as `share_change` with `meta.linkPreview`.

## The admin default and the tri-state choice (31 October 2026)

Every gated link unfurled as the same "canvas-drop" card, so links in an org's Slack
were indistinguishable, and nobody had flipped the per-canvas switch. Google Docs,
Notion and Figma do the same for private links unless their Slack app is installed;
those apps post a rich unfurl with the sharer's credentials, which everyone in the
channel then sees. We chose a server-side default over a Slack app:

- `access.linkPreviewDefault` (`off` | `title` | `cover`, default `off`) applies to
  **whole-org** canvases only. Restricted canvases and password-protected public links
  still need the per-canvas switch. The unfurler is Slack's server, not a member, so the
  default reveals the title to anyone holding the URL in any app; that is the trade the
  admin makes, which is why it is admin-only and off by default.
- The per-canvas choice is now `link_preview_mode` (`on` | `off` | NULL = follow the
  default). A boolean cannot express "follow", and an explicit off must survive the admin
  turning the default on. `link_preview` is still written (= `on`) so a rollback keeps
  opt-ins; migration 0048 backfills `on` from it. API: `linkPreview: true | false | null`.
- One resolver, `canvas/link-preview.ts`, backs the middleware, the MCP
  `linkPreviewShows` field, and (mirrored) the dashboard toggle. Liveness is checked
  only at unfurl time.
- A settings read failure resolves to `off`. Every fallback in this path must reveal
  less, not more.
- The generic card is titled with the slug parsed from the request URL, never from a
  lookup: the sharer already pasted that text, and a nonexistent slug gets the same card,
  so the card is not an existence oracle.

## Keeping a screenshot as the cover

Screenshots and uploaded covers share the same rendition keys, so "use this screenshot
as my cover" is only a `previewMode` flip to `custom` (`keepScreenshotAsCover`,
`POST /:id/preview/keep`, MCP `set_canvas_preview keepScreenshot`). It is allowed only
for a screenshot the owner can see (`auto` + `previewVisible` + the `og` blob exists).
The capture worker now re-reads `previewMode` after capturing and before writing, since
a capture takes seconds and an upload or keep in that window used to be overwritten.

Debugging tip: `curl -A "Slackbot-LinkExpanding 1.0" <url>` shows the card Slack gets,
and the same UA against the `og:image` URL must return `image/*`.
