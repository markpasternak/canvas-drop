import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { decideCanvasAccess } from "../canvas/authorization.js";
import { assertCapability } from "../canvas/capability-guard.js";

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
const RATE_WINDOW_MS = 60_000;

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
  isAdmin: boolean;
}

export interface Conn {
  readonly socket: Socket;
  readonly canvasId: string;
  readonly user: ConnUser;
  readonly channels: Set<string>;
  /** Sliding-window publish timestamps for per-user rate limiting. */
  readonly sends: number[];
  closed: boolean;
}

export interface HubDeps {
  config: Config;
  /** Re-fetch the canvas for live re-authorization. */
  resolveCanvas(canvasId: string): Promise<Canvas | null>;
  /** Optional liveness check — false drops the socket (blocked / deleted user). */
  isUserActive?(userId: string): Promise<boolean>;
}

type PresenceUser = { id: string; name: string };

function send(conn: Conn, obj: unknown): void {
  if (conn.closed) return;
  conn.socket.send(JSON.stringify(obj));
}

export function createHub(deps: HubDeps) {
  /** canvasId → live connections. */
  const byCanvas = new Map<string, Set<Conn>>();

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
    conns(conn.canvasId).delete(conn);
    conn.socket.close(code, reason);
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
      conns(conn.canvasId).delete(conn);
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
      const canvas = await deps.resolveCanvas(canvasId);
      const now = Date.now();
      for (const conn of live) {
        if (conn.closed) continue;
        if (!canvas) {
          dropConn(conn, CLOSE_UNAUTHORIZED, "canvas gone");
          continue;
        }
        const decision = decideCanvasAccess(
          canvas,
          { id: conn.user.id, isAdmin: conn.user.isAdmin },
          now,
        );
        if (decision.action === "deny") {
          dropConn(conn, CLOSE_UNAUTHORIZED, decision.reason);
          continue;
        }
        if (!assertCapability(canvas, "realtime", deps.config)) {
          dropConn(conn, CLOSE_CAPABILITY_DISABLED, "realtime disabled");
          continue;
        }
        if (deps.isUserActive && !(await deps.isUserActive(conn.user.id))) {
          dropConn(conn, CLOSE_UNAUTHORIZED, "user inactive");
        }
      }
    },

    /**
     * Drop every non-owner/non-admin socket of a canvas (D-RT-6). Called when a
     * password is newly set: those viewers hold no re-verified gate grant, so they
     * must re-handshake through the gate.
     */
    async dropGatedNonOwners(canvasId: string): Promise<void> {
      const live = [...conns(canvasId)];
      if (live.length === 0) return;
      const canvas = await deps.resolveCanvas(canvasId);
      for (const conn of live) {
        if (conn.closed) continue;
        const isOwner = !!canvas && canvas.ownerId === conn.user.id;
        if (!isOwner && !conn.user.isAdmin) {
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
