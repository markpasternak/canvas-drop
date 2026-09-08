---
title: Permission admin visibility, marketing and rollout readiness
execution: code
---

Keep one permission model. Complete PR #117 with admin inspection of resource
policies and audience settings, accurate marketing and README copy, and rollout
guidance that preserves application intent through deliberate canvas adaptation.
Do not introduce legacy compatibility, automatic permission broadening, role
promotion or automatic data/author backfills. Do not merge or deploy.

Admin inspection is read-only metadata: show collection/file presets and operation
rights, channels, Connection policies and AI/Connection audiences without exposing
private records or credentials. Owners/editors manage policies in Backend; admin
status alone is not a runtime role. Cover the API and rendered inspector in tests.

Capture actual Backend defaults, advanced permissions, admin inspection and prune
screenshots at useful desktop/mobile widths. Document the cutover requirements:
authored comments and attachments, participant realtime signals, role-derived
presenter controls, service audiences, SDK refresh and owner/editor/viewer checks.
Keep organization-specific audit details outside the open-source repository.

Run lint, typecheck, generated docs, both database suites, dashboard tests and build.
Review changes and update the existing PR through green CI. Canvas code/data
adaptations and coordinated production rollout remain separate deployment work.
