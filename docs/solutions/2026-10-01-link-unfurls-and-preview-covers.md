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

Debugging tip: `curl -A "Slackbot-LinkExpanding 1.0" <url>` shows the card Slack gets,
and the same UA against the `og:image` URL must return `image/*`.
