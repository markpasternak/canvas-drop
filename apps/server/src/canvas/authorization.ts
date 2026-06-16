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
 * (`public_link`, resolved by {@link resolveAccessContext} from the owner's U10
 * capability; an absent value is treated as not-enabled by the table).
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
 * The allowlist lookup key for a principal: a member matches by user id, a guest by
 * email, anyone else matches nothing. The single mapping shared by
 * {@link resolveAccessContext} and the realtime hub's re-auth, so a new principal
 * kind can't be handled one way here and silently fall through to `{}` there.
 */
export function principalLookupKey(principal: Principal): { userId?: string; email?: string } {
  if (principal.kind === "member") return { userId: principal.id };
  if (principal.kind === "guest") return { email: principal.email };
  return {};
}

/**
 * Pure decision table — no HTTP, no I/O — so every branch is exhaustively
 * unit-testable (KTD4: the single seam shared by the content chain, the runtime
 * API, and the realtime handshake). Order matters (KTD-6):
 *   1. deleted/archived   → 404 (gone / offline; opaque even to the owner)
 *   2. disabled           → 403 (owner/admin still learn why)
 *   3. owner               → allow, full (members only; a non-owner admin gets NO
 *                            content bypass — it falls through to the per-rung check
 *                            at step 5 and is treated like an ordinary member)
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
  // Owner (members only) bypasses the rung and the gate. Admins do NOT bypass the
  // rung for CONTENT: an admin falls through to the per-rung checks below and is
  // treated like a normal member — a private (or unlisted specific_people) canvas
  // resolves to 404 for them. Admin *management* (block / archive / delete /
  // metadata) lives on separate routes (admin/authz.ts) and is unaffected.
  if (principal.kind === "member" && canvas.ownerId === principal.id) {
    return { action: "allow", needsPasswordGate: false, staticOnly: false };
  }
  // A guest session is scoped to exactly the canvas it was invited to (R11/§12.0 #3):
  // a guest invited to X can never reach Y, at any rung.
  if (principal.kind === "guest" && principal.canvasId !== canvas.id) {
    return { action: "deny", status: 404, reason: "not_invited" };
  }

  const expired = canvas.sharedExpiresAt !== null && canvas.sharedExpiresAt <= now;
  // The magic link is the guest's gate, so guests bypass the per-canvas password.
  // Admins also bypass it (trusted operators) on the rungs they can still reach
  // (whole_org / public_link); normal members and anonymous visitors still face it
  // where set (R4/R21). Admins remain blocked from private/unlisted content above.
  const isAdminMember = principal.kind === "member" && principal.isAdmin;
  const gate = principal.kind === "guest" || isAdminMember ? false : canvas.passwordHash !== null;

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
      // Admin-gated per owner account (U10): default-deny unless the caller resolved
      // the owner's publish capability as enabled (resolveAccessContext). The realtime
      // hub doesn't resolve it, but it drops every static-only non-owner socket below,
      // so a public_link socket is never left live by this absence.
      if (!ctx.publicEnabled) return { action: "deny", status: 404, reason: "owner_only" };
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
  canvases: Pick<CanvasesRepository, "isPrincipalAllowed" | "isOwnerPublishEnabled">,
  canvas: Canvas | null,
  principal: Principal,
): Promise<AccessContext> {
  // public_link: resolve the owner's publish capability so the decision table can
  // deny a canvas whose owner lost the grant, independent of the write-time sweep
  // (defense-in-depth; the two layers together honor §12.0 #3/#5).
  if (canvas?.access === "public_link") {
    return { publicEnabled: await canvases.isOwnerPublishEnabled(canvas.ownerId) };
  }
  if (canvas?.access !== "specific_people") return {};
  if (principal.kind === "anonymous") return { isAllowed: false };
  return { isAllowed: await canvases.isPrincipalAllowed(canvas.id, principalLookupKey(principal)) };
}

/** The acting principal for a canvas-facing request: the resolver-set guest/
 *  anonymous principal (U7) if present, else the org member from the gateway. */
export function requestPrincipal(c: { get: (k: "principal" | "user") => unknown }): Principal {
  const p = c.get("principal") as Principal | undefined;
  if (p) return p;
  const user = c.get("user") as { id: string; isAdmin: boolean } | undefined;
  // In production the content/runtime path always has one or the other; fall back
  // to anonymous defensively rather than dereferencing an absent user.
  return user ? memberPrincipal(user) : { kind: "anonymous" };
}

/** Attribution id for audit/usage on the canvas content path (U9/U11): a member or
 *  guest by principal id, an anonymous public visitor by a stable sentinel. */
export function principalAttributionId(c: { get: (k: "principal" | "user") => unknown }): string {
  const p = requestPrincipal(c);
  return p.kind === "anonymous" ? "anonymous-via-public-link" : p.id;
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
