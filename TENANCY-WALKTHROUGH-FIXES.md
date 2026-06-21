# Tenancy walkthrough — findings & fixes

Found during a live browser walkthrough of Tenancy P1.

> **Guiding principle (user feedback):** NEVER let the user pick/toggle something the UI
> can't actually do. Don't show-then-silently-reject — gate the control (disable/hide) with
> an inline reason. This is the spine of the polish fixes below.

## Done (committed in `fix(tenancy): walkthrough polish`)

1. **Scope now visible in the views.** A `ScopeBadge` (👤 Personal / 🏢 <Org>) shows on the
   Your-canvases cards + rows and the canvas detail header. Server exposes `orgId` on the
   owner canvas view; the dashboard maps it to a name via `/api/me.orgs`.
2. **Clearer Personal-vs-Org hint** at the create picker, incl. "this choice is fixed once
   created."
3. **"Whole org" greyed-out on a Personal canvas** (member, active tenancy) with an inline
   reason, instead of click → silent server 409. Server 409 kept as a backstop.
4. **"guest" disambiguated.** The per-canvas section is now "Invited-people permissions"
   ("…the people you invite to THIS canvas — not outside-the-org guests, and separate from
   your own AI budget"), and the AI toggle reads "Let invited people use AI."
5. **Gallery listing gated to eligible canvases.** "List in the gallery" is disabled unless
   the canvas is Whole-org or Public-link, with "Only a Whole-org or Public-link canvas can
   be listed in the gallery." (Was previously a no-op save on Specific-people canvases.)

## Open — decide at DEPLOY time (from the real prod dry-run)

- **The 8 gmail-owned `whole_org` canvases would clamp to private.** Running
  `pnpm tenancy:plan` against a copy of the prod DB (with org domain `seenthis.se`):
  18 users → 12 members / 6 guests; **1 admin reclassified to guest**
  (`mark.pasternak@gmail.com`); **8 guest-owned `whole_org` canvases clamp to private** —
  including `showcase` and `studiodemoroadmap`. Decide before `--apply`:
  re-own them to a `seenthis.se` account, make `showcase` a `public_link`, or accept they go
  private. Add this to the deploy checklist. (The 0026 migration ran clean on the real prod
  data — good validation.)

## Open — P2 / later (not bugs)

- **Re-homing.** A canvas's home is set once at create and is immutable in P1 — so a Personal
  canvas can't later be shared org-wide, and the 8 clamped canvases above can't be fixed
  in-product. Add a guarded **"Move to workspace"** action (membership check + audit event).
- **Tenancy admin surface.** No admin UI for the org in P1 (org is env-config + boot). Worth
  adding: a member/guest roster view and the re-home action above. P2/P3.
- **Optional: tighten the gallery guard server-side.** Fix #5 is UI-only; the management/MCP
  settings still *allow* listing a Specific-people canvas (it just no-ops). For full
  agent-native parity, extend `resolveSettingsUpdate`'s NOT_SHARED guard to require
  whole_org/public_link when `galleryListed` is set. Small change + test.
- **Teams (Phase 2).** The `team` rung is reserved in the CHECK and rejected by
  `decideCanvasAccess`; the membership resolver is DI-ready for `derived ∪ explicit`. Plan:
  `docs/plans/2026-06-20-003-feat-tenancy-p2-teams-plan.md`.
