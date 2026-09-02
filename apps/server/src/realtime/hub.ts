import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import {
  decideCanvasAccess,
  memberPrincipal,
  principalLookupKey,
} from "../canvas/authorization.js";
import { assertCapability } from "../canvas/capability-guard.js";
import { resolveManagementRole } from "../canvas/role.js";
import type { EditorScope } from "../db/repositories/canvases.js";
import type { Principal } from "../http/types.js";
import type { Logger } from "../log/logger.js";

/**
 * In-memory realtime pub/sub + presence hub (§6.7 / D22, plan 009 / M9, D-RT-3).
 * Single-process: channels, presence, and messages live in process memory ONLY —
 * never persisted (durable state belongs in KV, §6.7.6). Horizontal scaling later
 * needs a broker (§18 known limit).
 *
 * Cross-canvas isolation is structural: a connection's `canvasId` is fixed at
 * handshake from the server-resolved canvas, and every operation is scoped to that
 * canvasId — a client-supplied channel name is only a key *within* its canvas, so a
 * socket can never reach another canvas's channels (§12.0 #4). Sender identity on
 * presence/publish comes from the server-resolved `user`, never the client frame
 * (§12.0 #2/#10).
 *
 * The whole wire protocol lives in {@link RealtimeHub.handleMessage} so it is
 * unit-testable with fake sockets — no real WebSocket needed.
 */

/** Realtime limits (§12.3). */
export const MAX_CONNECTIONS_PER_CANVAS = 30;
export const MAX_MESSAGES_PER_MIN = 100;
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Max distinct channels a single connection may subscribe to (resource bound). */
export const MAX_CHANNELS_PER_CONN = 64;
/** Max byte length of a channel name (resource bound; well under the frame cap). */
export const MAX_CHANNEL_BYTES = 128;
/** Sliding rate-limit window for per-connection publishes. */
export const RATE_WINDOW_MS = 60_000;

/** Close codes (D-RT-2). */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_CAPABILITY_DISABLED = 4403;
export const CLOSE_LIMIT = 4429;

/** The minimal socket the hub drives — real ws or a fake in tests. */
export interface Socket {
  send(data: string): void;
  close(code: number, reason?: string): void;
}

export interface ConnUser {
  id: string;
  name: string;
  /** The account email — what the live org-membership resolver keys on (review #5). */
  email?: string;
  isAdmin: boolean;
  /** The caller's org membership at handshake (plan 002 U3), server-resolved. Used by
   *  the re-auth fabrication fallback so a member's live `whole_org` socket keeps the
   *  correct org scope (not ∅) across heartbeats — never wrongly dropped or kept. */
  orgIds: Set<string>;
  /** The full principal (U9) so live re-auth re-decides guests/anonymous correctly,
   *  not as a member. Defaults to a member principal for callers that omit it. */
  principal?: Principal;
}

export interface Conn {
  readonly socket: Socket;
  readonly canvasId: string;
  readonly user: ConnUser;
  readonly channels: Set<string>;
  /** Sliding-window publish timestamps for per-connection rate limiting. A user
   *  with multiple connections has a separate window per connection. */
  readonly sends: number[];
  closed: boolean;
}

export interface HubDeps {
  config: Config;
  /** Optional logger so fail-closed re-auth drops leave a server-side trace. */
  log?: Logger;
  /** Re-fetch the canvas for live re-authorization. */
  resolveCanvas(canvasId: string): Promise<Canvas | null>;
  /** Optional liveness check — false drops the socket (blocked / deleted user). */
  isUserActive?(userId: string): Promise<boolean>;
  /** People-list membership for live re-auth, consulted at EVERY rung (U3/U9; restricted
   *  access model). Matches a member by userId or the canvas's own guest by email. When
   *  omitted, nobody re-authorizes as listed (the rung alone decides). */
  isPrincipalAllowed?(
    canvasId: string,
    principal: { userId?: string; email?: string },
  ): Promise<boolean>;
  /** Granted-team match for live re-auth, consulted at EVERY rung (plan 003 U4): a member
   *  of a granted team AND of that team's org (live re-join). Omitted ⇒ no team matches. */
  teamMatch?(canvasId: string, userId: string, viewerOrgIds: Set<string>): Promise<boolean>;
  /** Effective-editor probe for live re-auth (editor-roles plan, KD6/R22) — the canvases
   *  repo's `isEffectiveEditor`, fed to the shared role resolver so the hub keeps editors
   *  connected (and exempt from the password gate) exactly where the HTTP gates admit
   *  them. Omitted ⇒ nobody is an editor (fail-closed). */
  isEffectiveEditor?(canvasId: string, userId: string, scope: EditorScope): Promise<boolean>;
  /** Live org membership for a member (review #5): re-resolved on every sweep so a socket
   *  opened before an org departure loses its org-scoped grants (whole_org, team, editor)
   *  on the next heartbeat, exactly like HTTP and MCP do per request. Omitted ⇒ the
   *  handshake-time set is kept. A resolver error fails closed (the socket is dropped). */
  resolveOrgIds?(user: { id: string; email: string }): Promise<Set<string>>;
}

type PresenceUser = { id: string; name: string };

/**
 * Send to one connection. A real WebSocket `.send()` throws synchronously on a
 * half-closed/broken socket — guard it so a single dead socket can't abort a
 * broadcast loop and starve the other subscribers (reliability review). On throw,
 * mark the conn closed so the caller's loop skips it and the next sweep removes it.
 */
function send(conn: Conn, obj: unknown): void {
  if (conn.closed) return;
  try {
    conn.socket.send(JSON.stringify(obj));
  } catch {
    conn.closed = true;
  }
}

export function createHub(deps: HubDeps) {
  /** canvasId → live connections. */
  const byCanvas = new Map<string, Set<Conn>>();

  /** The shared role resolver's deps, over the hub's function-shaped probe. */
  const roleDeps = {
    canvases: { isEffectiveEditor: deps.isEffectiveEditor ?? (async () => false) },
    tenancyActive: !!deps.config.org.name,
  };

  /**
   * The connection's management role (owner / editor / none) via the SAME resolver the
   * HTTP and MCP gates use (KTD1). Fail-closed: a resolver error reads as `none`, so a
   * transient DB error drops the socket rather than leaving a stale editor grant alive.
   */
  async function roleOf(canvas: Canvas, conn: Conn): Promise<"owner" | "editor" | "none"> {
    if (conn.user.principal && conn.user.principal.kind !== "member") return "none";
    try {
      return await resolveManagementRole(
        canvas,
        memberPrincipal(conn.user, conn.user.orgIds),
        roleDeps,
      );
    } catch (err) {
      deps.log?.error(
        { err, canvasId: canvas.id, userId: conn.user.id },
        "realtime: role resolve error — failing closed",
      );
      return "none";
    }
  }

  /**
   * Refresh a member connection's org set from the live resolver (review #5). Returns
   * false when the resolver failed — callers drop the socket (fail closed) rather than
   * trust a stale grant. Guests and connections without an email keep their set.
   */
  async function refreshOrgIds(conn: Conn): Promise<boolean> {
    if (!deps.resolveOrgIds || !conn.user.email) return true;
    if (conn.user.principal && conn.user.principal.kind !== "member") return true;
    try {
      const fresh = await deps.resolveOrgIds({ id: conn.user.id, email: conn.user.email });
      conn.user.orgIds = fresh;
      if (conn.user.principal?.kind === "member") conn.user.principal.orgIds = fresh;
      return true;
    } catch (err) {
      deps.log?.error(
        { err, canvasId: conn.canvasId, userId: conn.user.id },
        "realtime: org membership resolve error — failing closed",
      );
      return false;
    }
  }

  function conns(canvasId: string): Set<Conn> {
    let s = byCanvas.get(canvasId);
    if (!s) {
      s = new Set();
      byCanvas.set(canvasId, s);
    }
    return s;
  }

  /** Subscribers of a channel within a canvas. */
  function subscribers(canvasId: string, channel: string): Conn[] {
    return [...conns(canvasId)].filter((c) => c.channels.has(channel));
  }

  /** Distinct users (deduped) currently subscribed to a channel. */
  function presence(canvasId: string, channel: string): PresenceUser[] {
    const seen = new Map<string, PresenceUser>();
    for (const c of subscribers(canvasId, channel)) {
      if (!seen.has(c.user.id)) seen.set(c.user.id, { id: c.user.id, name: c.user.name });
    }
    return [...seen.values()];
  }

  /** How many of a user's connections are subscribed to a channel. */
  function userSubCount(canvasId: string, channel: string, userId: string): number {
    return subscribers(canvasId, channel).filter((c) => c.user.id === userId).length;
  }

  function broadcast(canvasId: string, channel: string, obj: unknown, except?: Conn): void {
    for (const c of subscribers(canvasId, channel)) {
      if (c !== except) send(c, obj);
    }
  }

  function doSubscribe(conn: Conn, channel: string): void {
    if (conn.channels.has(channel)) {
      send(conn, { type: "subscribed", channel });
      return;
    }
    // Bound per-connection channel growth: each novel channel costs a `join`
    // broadcast and widens every later broadcast's linear scan, so cap it.
    if (conn.channels.size >= MAX_CHANNELS_PER_CONN) {
      send(conn, { type: "error", code: "CHANNEL_LIMIT", message: "too many channels" });
      return;
    }
    const wasPresent = userSubCount(conn.canvasId, channel, conn.user.id) > 0;
    conn.channels.add(channel);
    send(conn, { type: "subscribed", channel });
    send(conn, { type: "presence", channel, users: presence(conn.canvasId, channel) });
    // First connection of this user in the channel → others see a join.
    if (!wasPresent) {
      broadcast(
        conn.canvasId,
        channel,
        { type: "join", channel, user: { id: conn.user.id, name: conn.user.name } },
        conn,
      );
    }
  }

  function doUnsubscribe(conn: Conn, channel: string): void {
    if (!conn.channels.has(channel)) return;
    conn.channels.delete(channel);
    // Last connection of this user in the channel → others see a leave.
    if (userSubCount(conn.canvasId, channel, conn.user.id) === 0) {
      broadcast(conn.canvasId, channel, {
        type: "leave",
        channel,
        user: { id: conn.user.id, name: conn.user.name },
      });
    }
  }

  function rateLimited(conn: Conn, now: number): boolean {
    // prune outside the window
    while (conn.sends.length > 0 && (conn.sends[0] as number) <= now - RATE_WINDOW_MS) {
      conn.sends.shift();
    }
    if (conn.sends.length >= MAX_MESSAGES_PER_MIN) return true;
    conn.sends.push(now);
    return false;
  }

  function doPublish(conn: Conn, channel: string, event: string, data: unknown, now: number): void {
    if (rateLimited(conn, now)) {
      send(conn, { type: "error", code: "RATE_LIMITED", message: "too many messages" });
      return;
    }
    // Attribution from the SERVER-resolved identity — never a client-sent `from`.
    broadcast(conn.canvasId, channel, {
      type: "message",
      channel,
      event,
      data,
      from: { id: conn.user.id, name: conn.user.name },
    });
  }

  function dropConn(conn: Conn, code: number, reason?: string): void {
    if (conn.closed) return;
    // Emit leaves for every channel before tearing down.
    for (const channel of [...conn.channels]) doUnsubscribe(conn, channel);
    conn.closed = true;
    removeConn(conn);
    // Guard close() too: a throwing socket must not abort closeAll/dropCanvas/
    // revalidateCanvas iteration over the remaining sockets.
    try {
      conn.socket.close(code, reason);
    } catch {
      /* socket already torn down */
    }
  }

  /** Delete a conn from its canvas Set and prune the Set once it empties, so
   *  `byCanvas` never accumulates one stale empty Set per canvas ever connected. */
  function removeConn(conn: Conn): void {
    const set = byCanvas.get(conn.canvasId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) byCanvas.delete(conn.canvasId);
  }

  return {
    /** Register a connection, or null if the per-canvas limit is reached. */
    connect(canvasId: string, user: ConnUser, socket: Socket): Conn | null {
      if (conns(canvasId).size >= MAX_CONNECTIONS_PER_CANVAS) return null;
      const conn: Conn = {
        socket,
        canvasId,
        user,
        channels: new Set(),
        sends: [],
        closed: false,
      };
      conns(canvasId).add(conn);
      return conn;
    },

    /** Socket closed by the client / network. */
    disconnect(conn: Conn): void {
      if (conn.closed) return;
      for (const channel of [...conn.channels]) doUnsubscribe(conn, channel);
      conn.closed = true;
      removeConn(conn);
    },

    connectionCount(canvasId: string): number {
      return conns(canvasId).size;
    },

    presence,

    /** Handle one inbound frame (raw string). The full protocol lives here. */
    handleMessage(conn: Conn, raw: string, now: number = Date.now()): void {
      if (conn.closed) return;
      if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
        send(conn, { type: "error", code: "MESSAGE_TOO_LARGE", message: "frame exceeds 16KB" });
        return;
      }
      let frame: { type?: unknown; channel?: unknown; event?: unknown; data?: unknown };
      try {
        frame = JSON.parse(raw);
      } catch {
        send(conn, { type: "error", code: "INVALID_FRAME", message: "frame is not valid JSON" });
        return;
      }
      const channel = typeof frame.channel === "string" ? frame.channel : "";
      // Reject an over-long channel name on the channel-bearing frame types before
      // it can be added to conn.channels / fan-out keys (resource bound).
      if (
        channel &&
        Buffer.byteLength(channel) > MAX_CHANNEL_BYTES &&
        (frame.type === "subscribe" ||
          frame.type === "unsubscribe" ||
          frame.type === "publish" ||
          frame.type === "presence")
      ) {
        send(conn, {
          type: "error",
          code: "CHANNEL_NAME_TOO_LARGE",
          message: "channel name too long",
        });
        return;
      }
      switch (frame.type) {
        case "subscribe":
          if (channel) doSubscribe(conn, channel);
          break;
        case "unsubscribe":
          if (channel) doUnsubscribe(conn, channel);
          break;
        case "publish":
          if (channel) {
            doPublish(
              conn,
              channel,
              typeof frame.event === "string" ? frame.event : "",
              frame.data,
              now,
            );
          }
          break;
        case "presence":
          if (channel) {
            send(conn, { type: "presence", channel, users: presence(conn.canvasId, channel) });
          }
          break;
        default:
          send(conn, { type: "error", code: "UNKNOWN_FRAME", message: "unknown frame type" });
      }
    },

    /**
     * Re-authorize every live socket of a canvas (D-RT-6). Runs on access-changing
     * management mutations (settings/capabilities/disable/delete/slug-regen) and on
     * the periodic heartbeat. Drops sockets that lost canvas access (4401), lost the
     * realtime capability (4403), or whose user is no longer active (4401).
     */
    async revalidateCanvas(canvasId: string): Promise<void> {
      const live = [...conns(canvasId)];
      if (live.length === 0) return;
      // Fail closed: if the canvas lookup errors, drop every live socket rather than
      // abandoning the sweep and leaving stale grants alive.
      let canvas: Canvas | null;
      try {
        canvas = await deps.resolveCanvas(canvasId);
      } catch {
        for (const conn of live) dropConn(conn, CLOSE_UNAUTHORIZED, "revalidation_error");
        return;
      }
      const now = Date.now();
      for (const conn of live) {
        if (conn.closed) continue;
        if (!canvas) {
          dropConn(conn, CLOSE_UNAUTHORIZED, "canvas gone");
          continue;
        }
        // The org set is LIVE per sweep (review #5), like HTTP/MCP per request.
        if (!(await refreshOrgIds(conn))) {
          dropConn(conn, CLOSE_UNAUTHORIZED, "revalidation_error");
          continue;
        }
        // Re-decide against the socket's actual principal (member or guest, U9) so a
        // guest isn't mistaken for a member.
        const principal: Principal = conn.user.principal ?? {
          kind: "member",
          id: conn.user.id,
          isAdmin: conn.user.isAdmin,
          orgIds: conn.user.orgIds,
        };
        // The people-and-teams list applies at EVERY rung (restricted access model): the
        // same two lookups `resolveAccessContext` runs for an HTTP request, so the socket
        // verdict can't drift from the request verdict — a direct grant for a member (by
        // id) or this canvas's OWN guest (by email), and team membership for a member.
        const canBeListed =
          principal.kind === "member" ||
          (principal.kind === "guest" && principal.canvasId === canvas.id);
        let isAllowed = false;
        if (canBeListed && deps.isPrincipalAllowed) {
          try {
            isAllowed = await deps.isPrincipalAllowed(canvas.id, principalLookupKey(principal));
          } catch (err) {
            // Fail closed: a transient DB error must drop the socket (deny), never
            // leave a stale grant alive, and never abort the rest of the sweep.
            deps.log?.error(
              { err, canvasId, userId: conn.user.id },
              "realtime: isPrincipalAllowed error — failing closed",
            );
            isAllowed = false;
          }
        }
        let teamMatch = false;
        if (deps.teamMatch && principal.kind === "member") {
          try {
            teamMatch = await deps.teamMatch(canvas.id, principal.id, principal.orgIds);
          } catch (err) {
            // Fail closed, same as the allowlist guard above.
            deps.log?.error(
              { err, canvasId, userId: conn.user.id },
              "realtime: teamMatch error — failing closed",
            );
            teamMatch = false;
          }
        }
        // Editors stay connected at any rung (editor-roles plan, KD6/R22) — resolved
        // through the shared role resolver; a demoted editor is dropped by this sweep.
        const editorMatch = (await roleOf(canvas, conn)) === "editor";
        const decision = decideCanvasAccess(canvas, principal, now, {
          isAllowed,
          teamMatch,
          editorMatch,
          tenancyActive: !!deps.config.org.name,
        });
        if (decision.action === "deny") {
          dropConn(conn, CLOSE_UNAUTHORIZED, decision.reason);
          continue;
        }
        // A public_link canvas is static-only for every non-owner (members and
        // guests): no realtime. The decision allows the slug (files serve) but
        // staticOnly marks that primitives — including this socket — are refused,
        // so drop a live socket the instant a rung change makes it static-only
        // (§12.0 #5 lifecycle; owners hit the owner bypass with staticOnly:false).
        if (decision.staticOnly) {
          dropConn(conn, CLOSE_UNAUTHORIZED, "static_only");
          continue;
        }
        if (!assertCapability(canvas, "realtime", deps.config)) {
          dropConn(conn, CLOSE_CAPABILITY_DISABLED, "realtime disabled");
          continue;
        }
        // Fail closed on a transient error too: drop the socket and keep sweeping
        // the rest, never abort the loop (mirrors the isPrincipalAllowed guard above).
        // Members only: a guest's conn.user.id is the synthetic `guest:<inviteId>`,
        // which the users table can never resolve — checking it would drop every
        // legacy-guest socket as "user inactive" on the first sweep. Guest liveness
        // is already re-decided above (allowlist match + decideCanvasAccess).
        let isActive = true;
        if (deps.isUserActive && principal.kind === "member") {
          try {
            isActive = await deps.isUserActive(conn.user.id);
          } catch (err) {
            deps.log?.error(
              { err, canvasId, userId: conn.user.id },
              "realtime: isUserActive error — failing closed",
            );
            isActive = false;
          }
        }
        if (!isActive) {
          dropConn(conn, CLOSE_UNAUTHORIZED, "user inactive");
        }
      }
    },

    /**
     * Drop every socket of a canvas that faces the password gate (D-RT-6). Called when
     * a password is newly set: those viewers hold no re-verified gate grant, so they
     * must re-handshake through the gate. Only the owner and effective editors are
     * exempt (they never face the gate — the owner / editor branches of
     * `decideCanvasAccess`); a non-owner admin faces the gate like any member, so its
     * live socket is dropped too.
     */
    async dropGatedNonOwners(canvasId: string): Promise<void> {
      const live = [...conns(canvasId)];
      if (live.length === 0) return;
      // Fail closed like revalidateCanvas: if the canvas lookup errors we cannot tell
      // owner from non-owner, so drop EVERY live socket rather than leaving a viewer
      // connected through a newly-set password gate with no trace (§12.0 stale grant).
      let canvas: Canvas | null;
      try {
        canvas = await deps.resolveCanvas(canvasId);
      } catch (err) {
        deps.log?.error(
          { err, canvasId },
          "realtime: dropGatedNonOwners resolveCanvas error — failing closed (dropping all sockets)",
        );
        for (const conn of live) dropConn(conn, CLOSE_UNAUTHORIZED, "password gate");
        return;
      }
      for (const conn of live) {
        if (conn.closed) continue;
        if (!(await refreshOrgIds(conn))) {
          dropConn(conn, CLOSE_UNAUTHORIZED, "password gate");
          continue;
        }
        const exempt = !!canvas && (await roleOf(canvas, conn)) !== "none";
        if (!exempt) {
          dropConn(conn, CLOSE_UNAUTHORIZED, "password gate");
        }
      }
    },

    /** Drop all sockets of a canvas (used by graceful shutdown / hard revoke). */
    dropCanvas(canvasId: string, code = CLOSE_UNAUTHORIZED): void {
      for (const conn of [...conns(canvasId)]) dropConn(conn, code);
    },

    /** Drop every socket across all canvases (graceful shutdown). */
    closeAll(code = 1001): void {
      for (const set of byCanvas.values()) {
        for (const conn of [...set]) dropConn(conn, code, "server shutting down");
      }
    },

    /** Canvas ids with at least one live connection (heartbeat iteration). */
    activeCanvasIds(): string[] {
      return [...byCanvas.entries()].filter(([, s]) => s.size > 0).map(([id]) => id);
    },
  };
}

export type RealtimeHub = ReturnType<typeof createHub>;
