# Product

## Register

product

## Users

Authenticated members of an organization who self-host canvas-drop. They're
technical-to-semi-technical: developers, designers, and internal builders who
want to deploy and share a small web artifact (a "canvas" — static HTML/CSS/JS)
in seconds and hand teammates a link. Their context is a working session, not a
browse: create or update a canvas, deploy a new version, check it's live, roll
back if needed, manage access. They arrive with a job in hand and want the tool
to get out of the way. A subset are admins managing org-wide settings, canvases,
and usage; a subset are first-run self-hosters evaluating whether to trust the
project with their work.

## Product Purpose

canvas-drop is an open-source (MIT), self-hostable, deployment-agnostic platform
for deploying and sharing small static web artifacts inside an organization — no
telemetry, no phone-home, org-agnostic. The dashboard SPA (area E) is the human
front door to the platform: create a canvas, deploy via folder/ZIP/paste/API,
edit drafts and publish versions on content-addressed storage, roll back, archive,
and administer access. Success is that a member can go from idea to a shared live
URL in seconds, trust that a deploy did what they expected, and recover cleanly
when it didn't. Because it's OSS and self-hosted, the dashboard is also the
artifact that sells the repo — its own polish is the proof the platform is worth
running.

## Brand Personality

Precise, calm, and quietly confident — three words: **precise, trustworthy,
unobtrusive**. The voice is plain and exact: it names things correctly (slugs,
versions, keys read as identifiers), states status without hype, and never
performs. It feels like a well-made instrument — the tool disappears into the
task. Closest reference: **Linear** — crisp, fast, opinionated, near-monochrome
with a single accent, keyboard-respectful, no decoration that isn't doing work.

## Anti-references

- **Gradient-heavy AI-SaaS**: purple gradients, glowing hero-metric cards,
  blurred-glass surfaces, decorative motion. canvas-drop earns trust by
  restraint, not spectacle.
- **Enterprise / Bootstrap admin templates**: heavy chrome, boxy cards stacked
  everywhere, dated dense admin grids, generic component-kit feel. Density is
  fine where data needs it; dated admin-template scaffolding is not.

Also avoid the shared slop tells: tiny tracked uppercase eyebrows over every
section, numbered section scaffolding, side-stripe accent borders, gradient text,
identical card grids, modal-as-first-thought.

## Design Principles

1. **The tool disappears into the task.** Earned familiarity over novelty. Use
   standard product affordances (top bar + side nav, tables, inline edit, command
   patterns) so a user fluent in Linear/Vercel/Stripe trusts it on sight.
2. **The dashboard is the proof of taste.** Its own precision is the argument that
   the platform is worth self-hosting. System pages (login, password gate, 404,
   archived, disabled) get the same care as the core flows.
3. **Token-first, re-skinnable.** Every color/space/type/radius is a semantic CSS
   variable; any deployment re-skins via tokens, never a redesign. Components
   never hard-code a hex, font, or radius.
4. **Typography carries the brand.** One excellent open typeface family (Geist +
   Geist Mono), tight fixed rem scale, generous whitespace. Machine text (slugs,
   URLs, keys, versions) reads as mono identifiers.
5. **Refined by default, state-complete.** Deliberate empty states that teach,
   skeleton loading not mid-content spinners, motion ≤150ms that conveys state,
   no layout shift, dark and light both first-class from day one. Every
   interactive component ships default/hover/focus/active/disabled/loading.
6. **Restraint shows confidence.** Near-monochrome graphite ramp + one accent.
   The accent is reserved for primary actions, current selection, and state — not
   decoration.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**. Body text ≥4.5:1, large text ≥3:1, placeholder text held
to the same 4.5:1 (not muted-gray default). Full keyboard navigation with an
always-visible accent focus ring (never removed). `prefers-reduced-motion`
collapses the ≤150ms transitions to instant. Light and dark are both first-class
and system-driven, with a manual override. Don't encode meaning in color alone —
pair status color with text/icon. Forms have associated labels and clear,
specific error messages.
