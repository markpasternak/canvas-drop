# Compact automatic preview framing

Small tools occupied only the top of the 1440×960 capture, leaving their controls
tiny inside library thumbnails. Automatic captures now start at 900×600 CSS pixels,
retaining the existing 2× density and 3:2 card/thumb rendition sizes. This changes
the browser viewport rather than cropping guessed content bounds.

After the existing settle, a layout probe checks both root and body scroll widths.
Horizontal overflow of at least two pixels, missing/invalid metrics, a failed probe,
or its one-second Node-side deadline selects the original 1440×960 viewport. The
capture settles again after resizing. Both settles retain their existing five-second
Node deadlines; page-controlled timers cannot keep the new probe waiting forever.
The fallback resize has its own one-second Node deadline: if it cannot complete,
capture fails and runs the existing page cleanup rather than waiting indefinitely.

This is a conservative heuristic: layouts that hide overflow or rearrange at desktop
breakpoints still need visual verification. It does not promise to show an entire
scrolling page. Capture authentication, network restrictions, output dimensions, and
custom-cover encoding stay unchanged. Existing stored previews refresh through the
existing capture workflow; changing the viewport does not rewrite them in place.

Validation: 41 focused tests across capture, network restrictions, tokens, resolver,
and worker passed. Framing regressions cover compact fit, root/body overflow,
unavailable/failed/hung probes, a hung fallback resize, and cleanup after screenshot
failure. Rendered framing and refreshed marketing assets are checked in the integrated
U5 pass; these source tests do not claim browser verification.
