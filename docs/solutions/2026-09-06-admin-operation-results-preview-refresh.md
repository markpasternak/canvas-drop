---
title: Keep completed admin operations separate from refreshed previews
date: 2026-09-06
category: ui-bugs
tags: [admin, react-query, lifecycle, feedback]
---

After a successful archive, invalidating the admin query cache refetched the still-visible
impact preview. The now-archived canvases failed the archive eligibility check, so the dialog
displayed “Skipped: Requires active status” above successful “Completed” results.

Treat preview and results as separate display states. Once execution returns, hide the
preview (including loading/errors), show action-specific past-tense outcomes, and omit retry
after complete success. Keep originally excluded selections in the result list so mixed
selections remain accounted for. Failed or changed outcomes still allow a fresh preview.

Regression coverage simulates the successful mutation followed by an ineligible preview
refetch. It checks the success summary, absence of contradictory warnings/retry, preservation
of excluded items in mixed selections, and closing with Done. Existing coverage retains the
failed-preview retry guard. This is a presentation patch; authorization, lifecycle operations,
retention, and storage behavior are unchanged.

The owner explicitly requested an emergency commit/push directly to main, deployment, and
cleanup on 2026-09-06. Local review focused on cache refresh timing, partial results, retry
safety, and accessible result announcements.

Verification: all 60 admin dashboard tests, the full server suite (3,084 passed across both
dialects), and the dashboard suite (747 passed) passed. A real Chrome run against the updated
local UI with mocked API responses reproduced the post-archive refetch and verified the clear
success screen and Done action without changing any production canvas.
