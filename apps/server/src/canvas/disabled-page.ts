import type { Context } from "hono";
import { errorResponse } from "../http/error-pages.js";
import type { AppEnv } from "../http/types.js";

/**
 * Disabled-canvas response (§6.10.2, M7). A taken-down canvas's public URL shows
 * this page; the runtime API returns the typed `{ code: "DISABLED" }` 403 instead
 * (handled in canvas-api.ts). Content-negotiated, mirroring `serve.ts`'s 404:
 * browsers get a small self-contained HTML page, programmatic clients get the
 * stable `{ error: "disabled" }` JSON.
 *
 * The page is **static and org-agnostic** — the admin's `disabledReason` is NOT
 * interpolated here (it would leak an operator's internal note to anyone with the
 * URL). The owner sees the specific reason in their authenticated dashboard
 * (the owner/admin-gated `disabledReason` projection), never on this public page.
 *
 * Lives in its own module (not `serve.ts`) so `authorization.ts` can import it
 * without an `authorization.ts → serve.ts` dependency.
 */
export function disabledResponse(c: Context<AppEnv>): Response {
  return errorResponse(
    c,
    {
      status: 403,
      code: "disabled",
      title: "This canvas is disabled",
      message: "A platform administrator has taken this canvas offline.",
      hint: "If you own it, open your dashboard to see why.",
      // Public page shown to anyone with the URL — keep it identical for every visitor
      // (no "Signed in as …" footer), so it reveals nothing about who is looking.
      hideIdentity: true,
    },
    { error: "disabled" },
    {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
    },
  );
}
