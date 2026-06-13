import type { Canvas } from "@canvas-drop/shared/db";
import { createMiddleware } from "hono/factory";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";

/**
 * Canvas authorization (BUILD_BRIEF.md §12.0 invariant 3/5, §12.2). The single
 * highest-risk surface in this plan. Evaluated per request with NO cached grants
 * — a revoke/expiry is honored on the very next request.
 *
 * See docs/solutions/2026-06-13-auth-invariant-checklist.md.
 */
export type AccessDecision =
  | { action: "allow"; needsPasswordGate: boolean }
  | { action: "deny"; status: 404 | 403; reason: string };

export interface AccessUser {
  id: string;
  isAdmin: boolean;
}

/**
 * Pure decision table — no HTTP, no I/O — so every branch is exhaustively
 * unit-testable. Order matters (KTD-6):
 *   1. deleted            → 404 (gone; don't distinguish from never-existed)
 *   2. archived           → 404 (owner-retired & offline; gone on the public path,
 *                                 restorable from the dashboard — opaque even to the owner)
 *   3. disabled           → 403 (owner/admin still learn why; others get 403 too)
 *   4. owner or admin      → allow (owner always reaches their own canvas)
 *   5. not shared          → 404 (owner-only; don't confirm existence to others)
 *   6. share expired       → 404 (treat as revoked)
 *   7. shared & live        → allow, deferring to the password gate if set
 */
export function decideCanvasAccess(
  canvas: Canvas | null,
  user: AccessUser,
  now: number,
): AccessDecision {
  if (!canvas || canvas.status === "deleted") {
    return { action: "deny", status: 404, reason: "not_found" };
  }
  if (canvas.status === "archived") {
    // Offline & restorable. Checked before owner/admin so the live URL is opaque
    // to everyone; the owner manages/unarchives it via the dashboard, not the slug.
    return { action: "deny", status: 404, reason: "archived" };
  }
  if (canvas.status === "disabled") {
    return { action: "deny", status: 403, reason: "disabled" };
  }
  const isOwner = canvas.ownerId === user.id;
  if (isOwner || user.isAdmin) {
    return { action: "allow", needsPasswordGate: false }; // owner/admin bypass the gate
  }
  if (!canvas.shared) {
    return { action: "deny", status: 404, reason: "owner_only" };
  }
  if (canvas.sharedExpiresAt !== null && canvas.sharedExpiresAt <= now) {
    return { action: "deny", status: 404, reason: "share_expired" };
  }
  return { action: "allow", needsPasswordGate: canvas.passwordHash !== null };
}

export interface CanvasAccessDeps {
  canvases: CanvasesRepository;
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
    const user = c.get("user");
    const decision = decideCanvasAccess(canvas, user, Date.now());

    if (decision.action === "deny") {
      if (decision.status === 403) {
        return c.json({ error: decision.reason }, 403);
      }
      return c.json({ error: "not_found" }, 404);
    }

    // canvas is non-null on allow
    c.set("canvas", canvas as Canvas);
    c.set("needsPasswordGate", decision.needsPasswordGate);
    await next();
  });
}
