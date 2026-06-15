import type { Canvas } from "@canvas-drop/shared/db";
import { createMiddleware } from "hono/factory";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv, Principal } from "../http/types.js";
import { disabledResponse } from "./disabled-page.js";

/**
 * Canvas authorization (BUILD_BRIEF.md §12.0 invariant 3/5, §12.2). The single
 * highest-risk surface in this plan. Evaluated per request with NO cached grants
 * — a revoke/expiry is honored on the very next request.
 *
 * See docs/solutions/2026-06-13-auth-invariant-checklist.md.
 */
export type AccessDecision =
  | { action: "allow"; needsPasswordGate: boolean; staticOnly: boolean }
  | { action: "deny"; status: 404 | 403; reason: string };

/**
 * Context the pure decision table can't compute itself (caller-resolved so the
 * table stays I/O-free, KTD4): whether the principal is on this canvas's allowlist
 * (`specific_people`), and whether the owner account may publish public links
 * (`public_link`; defaults true until U10 wires the capability).
 */
export interface AccessContext {
  isAllowed?: boolean;
  publicEnabled?: boolean;
}

/** Build a member principal from the org-resolved user (the normal gateway path). */
export function memberPrincipal(user: { id: string; isAdmin: boolean }): Principal {
  return { kind: "member", id: user.id, isAdmin: user.isAdmin };
}

/**
 * Pure decision table — no HTTP, no I/O — so every branch is exhaustively
 * unit-testable (KTD4: the single seam shared by the content chain, the runtime
 * API, and the realtime handshake). Order matters (KTD-6):
 *   1. deleted/archived   → 404 (gone / offline; opaque even to the owner)
 *   2. disabled           → 403 (owner/admin still learn why)
 *   3. owner or admin     → allow, full (members only)
 *   4. guest scoped to another canvas → 404 (a guest can't reach an un-invited canvas)
 *   5. per-rung principal check → allow (with expiry + password modifiers) or 404
 *
 * `staticOnly` marks a public_link allow for a non-owner — the serve layer serves
 * files but every primitive is refused (R17, enforced in U9/U11).
 */
export function decideCanvasAccess(
  canvas: Canvas | null,
  principal: Principal,
  now: number,
  ctx: AccessContext = {},
): AccessDecision {
  if (!canvas || canvas.status === "deleted") {
    return { action: "deny", status: 404, reason: "not_found" };
  }
  if (canvas.status === "archived") {
    return { action: "deny", status: 404, reason: "archived" };
  }
  if (canvas.status === "disabled") {
    return { action: "deny", status: 403, reason: "disabled" };
  }
  // Owner / admin (members only) bypass the rung and the gate.
  if (principal.kind === "member" && (canvas.ownerId === principal.id || principal.isAdmin)) {
    return { action: "allow", needsPasswordGate: false, staticOnly: false };
  }
  // A guest session is scoped to exactly the canvas it was invited to (R11/§12.0 #3):
  // a guest invited to X can never reach Y, at any rung.
  if (principal.kind === "guest" && principal.canvasId !== canvas.id) {
    return { action: "deny", status: 404, reason: "not_invited" };
  }

  const expired = canvas.sharedExpiresAt !== null && canvas.sharedExpiresAt <= now;
  // The magic link is the guest's gate, so guests bypass the per-canvas password;
  // members and anonymous visitors still face it where set (R4/R21).
  const gate = principal.kind === "guest" ? false : canvas.passwordHash !== null;

  switch (canvas.access) {
    case "private":
      return { action: "deny", status: 404, reason: "owner_only" };
    case "whole_org":
      // Org members only — guests/anonymous are outsiders.
      if (principal.kind !== "member") return { action: "deny", status: 404, reason: "owner_only" };
      if (expired) return { action: "deny", status: 404, reason: "share_expired" };
      return { action: "allow", needsPasswordGate: gate, staticOnly: false };
    case "specific_people":
      if (principal.kind === "anonymous")
        return { action: "deny", status: 404, reason: "owner_only" };
      if (!ctx.isAllowed) return { action: "deny", status: 404, reason: "owner_only" };
      if (expired) return { action: "deny", status: 404, reason: "share_expired" };
      return { action: "allow", needsPasswordGate: gate, staticOnly: false };
    case "public_link":
      // Admin-gated per owner account (U10; defaults open until then).
      if (ctx.publicEnabled === false) return { action: "deny", status: 404, reason: "owner_only" };
      if (expired) return { action: "deny", status: 404, reason: "share_expired" };
      // Static-only for every non-owner (anonymous AND org members) — R17.
      return { action: "allow", needsPasswordGate: gate, staticOnly: true };
    default:
      return { action: "deny", status: 404, reason: "owner_only" };
  }
}

export interface CanvasAccessDeps {
  canvases: CanvasesRepository;
}

/**
 * Resolve the parts of {@link AccessContext} that need a DB lookup, for a given
 * principal + canvas. The single canonical allowlist check (KTD4) every caller
 * routes through — keeps the membership predicate from drifting across the content
 * chain, the runtime API, and the realtime handshake. Only the `specific_people`
 * rung needs the lookup; other rungs short-circuit to no context.
 */
export async function resolveAccessContext(
  canvases: Pick<CanvasesRepository, "isPrincipalAllowed">,
  canvas: Canvas | null,
  principal: Principal,
): Promise<AccessContext> {
  if (canvas?.access !== "specific_people") return {};
  if (principal.kind === "member") {
    return { isAllowed: await canvases.isPrincipalAllowed(canvas.id, { userId: principal.id }) };
  }
  if (principal.kind === "guest") {
    return { isAllowed: await canvases.isPrincipalAllowed(canvas.id, { email: principal.email }) };
  }
  return { isAllowed: false };
}

/** The acting principal for a canvas-facing request: the resolver-set guest/
 *  anonymous principal (U7) if present, else the org member from the gateway. */
export function requestPrincipal(c: { get: (k: "principal" | "user") => unknown }): Principal {
  const p = c.get("principal") as Principal | undefined;
  if (p) return p;
  const user = c.get("user") as { id: string; isAdmin: boolean };
  return memberPrincipal(user);
}

/**
 * Middleware: resolve the slug (set by resolveRequest → `canvasSlug`), run the
 * decision, and on allow place the canvas + a `needsPasswordGate` flag on the
 * context for the gate (U16) and serving (U17). Denials short-circuit here.
 */
export function canvasAccess(deps: CanvasAccessDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const slug = c.get("canvasSlug");
    if (!slug) return c.json({ error: "not_found" }, 404);

    const canvas = await deps.canvases.findBySlug(slug);
    const principal = requestPrincipal(c);
    const ctx = await resolveAccessContext(deps.canvases, canvas, principal);
    const decision = decideCanvasAccess(canvas, principal, Date.now(), ctx);

    if (decision.action === "deny") {
      if (decision.status === 403) {
        // `disabled` is the only 403 the decision table produces (§6.10.2). Render
        // the content-negotiated "disabled" page (HTML for browsers); the admin is
        // NOT exempted (the disabled branch fires before owner/admin), so even an
        // admin's slug load shows the page, never the content (§12.0 #5).
        if (decision.reason === "disabled") return disabledResponse(c);
        return c.json({ error: decision.reason }, 403);
      }
      return c.json({ error: "not_found" }, 404);
    }

    // canvas is non-null on allow
    c.set("canvas", canvas as Canvas);
    c.set("needsPasswordGate", decision.needsPasswordGate);
    c.set("staticOnly", decision.staticOnly);
    await next();
  });
}
