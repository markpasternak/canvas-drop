import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import type { GuestService } from "../auth/guest.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { Mailer } from "../email/mailer.js";

/** A guard failure carries a stable code + an HTTP-ish status the caller maps to its
 *  own envelope (the management route → c.json; the MCP tool → a `CODE: message` fail). */
export type InviteResult =
  | { ok: true }
  | { ok: false; code: string; message: string; status: 409 | 502 };

export interface InviteGuestDeps {
  config: Config;
  canvases: Pick<CanvasesRepository, "addAllowlistEntry">;
  /** Legacy guest magic-link service — retained only for old-data revocation/cutover. */
  guests?: GuestService;
  mailer?: Mailer;
  audit: unknown;
}

/**
 * Legacy guest magic-link creation is retired. Keep this helper as the single inert
 * compatibility seam until the old HTTP/MCP entry points are removed/repointed by the
 * Add person units; no caller may create a `guest_invites` row through it anymore.
 */
export async function inviteGuestToCanvas(
  deps: InviteGuestDeps,
  args: { canvas: Canvas; inviterName: string; actorId: string; email: string },
): Promise<InviteResult> {
  void deps;
  void args;
  return {
    ok: false,
    code: "GUEST_INVITES_RETIRED",
    message: "Guest magic-link invites are retired. Add the person through normal sign-in access.",
    status: 409,
  };
}
