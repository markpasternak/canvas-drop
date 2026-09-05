---
title: Keep the mobile font floor above utilities and mount dialogs before focusing
category: ui-bugs
date: 2026-09-05
---

# Mobile CSS layers and dialog opening focus

Two browser findings survived the initial green accessibility tests.

The canonical 16px phone-input rule was inside `@layer base`. Tailwind's utility layer won over it, leaving compact role selectors at 12px. Raising individual input recipes duplicated the policy and still missed those controls. Keep the single mobile rule outside cascade layers, with checkbox, radio, range and color exclusions. Browser computed styles now show 16px for text controls at 320px; desktop remains 14px for fields and 12px for compact role controls. See [the original mobile input learning](2026-06-19-mobile-input-zoom-and-row-action-wrap.md).

`useExitTransition` deferred opening until an effect set internal `mounted` state. A Dialog mounted closed therefore ran its open-keyed focus effect while the panel ref was null. The next render mounted the panel without rerunning focus. Return `mounted: open || mounted`: opening is immediate; only closing waits for the exit animation. Keep Dialog's callback refs and stable effect dependencies to avoid the historical CodeMirror measure loop. The real CodeMirror regression now asserts that Add file receives focus; exit delay and reduced-motion tests still pass.

Share's page heading sits beneath the canvas h1. Its sections need h3, rather than becoming siblings of its h2. An optional heading level on the shared Section component preserves other routes' headings. Explicit field IDs also need to own both the input and label; hint/description IDs are merged with caller-provided `aria-describedby`.

Clipboard completion is tied to the current value and attempt. A late success or failure after navigation must not show a toast, reset another copy's timer, or call a stale completion callback. Tests cover value changes, unmount, repeated attempts and rejection. The callback contract documents this lifetime.

Verification: both themes, Editorial and Workshop, 320/390px phones and landscape, keyboard dialogs, reduced motion, computed form sizes, correct heading outline, full local lint/typecheck/dual-dialect/dashboard tests and build. Claude Opus 5 supplied an independent adversarial review; ordinary persona and validation passes ran sequentially in the main thread under AGENTS.md.
