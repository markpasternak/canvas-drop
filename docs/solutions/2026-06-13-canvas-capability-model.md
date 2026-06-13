---
title: Canvas capability model — per-canvas backend toggles, the effective-state rule, and the guard seam
type: architecture
area: capabilities
date: 2026-06-13
---

## What this is

The foundation (plan 006) that lets a canvas opt into **backend capability** (KV, files,
AI, realtime) before any of those primitives exist (M6/M9). It establishes the data model,
a single effective-state rule, a runtime guard seam, and the dashboard surfaces — so each
future primitive is a thin handler behind one shared check rather than retrofitted gating.

## The model (the load-bearing decisions)

- **Discrete boolean columns on `canvases`:** `backend_enabled` (default **false** —
  static-first) plus `cap_kv` / `cap_files` / `cap_ai` / `cap_realtime` (default **true**).
  Feature flags default on so flipping backend on yields all-features-live with no extra
  write. Chosen over a JSON blob for explicitness; future capability groups are new columns
  (cheap, greenfield).
- **`backend_enabled` is changeable, not permanent.** (The original ask floated a permanent
  choice tied to the API key; that was dropped once it was clear the deploy/programmatic API
  key is decoupled — see below.)
- **Identity (`me()`) has no column** — it is effective iff `backend_enabled`. Rendered
  read-only "always on" in the UI.
- **Sub-toggles persist when backend flips off (KTD-2).** `updateCapabilities` writes only
  the fields present in the patch; turning backend off never clears `cap_*`, so re-enabling
  restores prior per-feature choices. "All on" is the *creation* default, not a re-enable
  reset.
- **The deploy API key is untouched (KTD-5).** `api_key_hash` stays `notNull`, issued for
  every canvas, decoupled from the capability choice. Capability gating is about *runtime*
  primitives (proxy-identity authed); the key is for *programmatic deploy*. Don't conflate.

## The one rule: `effectiveCapabilities` (shared)

`packages/shared/src/capabilities/` owns the single source of truth:

```
effective(feature) = backend_enabled AND cap_<feature> AND operator_global(feature)
```

- `operator_global`: realtime ← `config.realtimeEnabled` (`CANVAS_DROP_REALTIME`); ai ←
  AI provider configured (`config.ai.apiKey` present); kv/files have **no** global switch.
- The server→globals mapping (`capabilityGlobals(config)`) lives server-side
  (`apps/server/src/canvas/capability-guard.ts`) and is imported by the management
  projection, so there is exactly one Config→globals translation.
- The management `publicCanvas` projection returns **both** `capabilities` (raw stored
  flags) and `effective` (after the AND), so the dashboard can show a feature that is
  on-but-operator-disabled with a "disabled by your administrator" hint.

## The guard seam (for future primitives)

`requireCapability(cap, config)` (Hono middleware) reads the canvas from `c.get("canvas")`
(set by `canvasAccess`, **server context — never client-asserted**) and returns
`403 { code: "CAPABILITY_DISABLED", capability }` when not effective; `500` if wired before
the canvas resolves. No primitive routes are mounted yet — when M6/M9 land, each route group
just adds `requireCapability("kv" | "files" | "ai" | "realtime" | "identity", config)`.
(Open follow-up: the `{code, capability}` 403 envelope differs from management's `{error}`
shape — pick one consistent envelope when primitives ship, and map it to a typed catchable
SDK error per BUILD_BRIEF §6.7.)

## Gotcha: optimistic UI must not turn an operator-gated feature ON

The dashboard can't see operator globals (realtime/ai), so the optimistic cache update in
`useUpdateCapabilities` must **never optimistically set `effective.ai`/`effective.realtime`
to true** — only ever down to false — and let `onSettled` confirm any upward transition.
Otherwise toggling a globally-disabled feature on briefly clears the "disabled by
administrator" hint, falsely signaling it went live. (Caught by the adversarial reviewer,
corroborated by correctness + testing; the server guard was always authoritative, so it was
UX-only — but exactly the kind of effective-vs-stored confusion to avoid.) kv/files have no
global, so optimistic-on is fine for them.

## Gotcha: the dashboard bundle is intentionally free of `@canvas-drop/shared`

No dashboard code imports the workspace `shared` package (keeps the Vite bundle clean of
config/db code). So the capability taxonomy is **mirrored locally** in the dashboard
(`canvas.capabilities.tsx` feature list, `api.ts` types) rather than imported from
`shared/capabilities`. The server consumes `shared/capabilities` directly. If a 5th feature
is ever added, update both the shared taxonomy AND the dashboard mirror — the `effective`
payload is server-computed, so a missed mirror only drops a UI toggle, not behavior.

See also [[dual-dialect-drizzle-seam]] (the column-add + migration-generation gotcha) and
[[auth-invariant-checklist]] (identity-from-server-context, owner-only, same-origin — all
upheld by the guard + PATCH endpoint).
