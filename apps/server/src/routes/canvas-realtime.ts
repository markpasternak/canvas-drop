import type { Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { requestPrincipal } from "../canvas/authorization.js";
import { assertCapability } from "../canvas/capability-guard.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import { requireCanvas } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";
import {
  CLOSE_CAPABILITY_DISABLED,
  CLOSE_LIMIT,
  type Conn,
  type RealtimeHub,
  type Socket,
} from "../realtime/hub.js";

export interface CanvasRealtimeDeps {
  config: Config;
  hub: RealtimeHub;
  usage: UsageEventsRepository;
  upgradeWebSocket: UpgradeWebSocket;
}

/**
 * Realtime WebSocket route (§6.7 / D22, plan 009 / M9), mounted at
 * `/v1/c/:slug/realtime` inside `canvasApiRoutes`. The upgrade flows through the
 * shared resolve + password-gate + cross-canvas-isolation middleware of
 * `canvasApiRoutes` first, so login, authorization, the password gate, and Origin
 * scoping are all enforced **before** the upgrade — an auth/authorization failure
 * refuses the upgrade (no 101). See D-RT-2.
 *
 * Capability gating is the ONE check that is post-101 (accept-then-close): the
 * socket is accepted, then `onOpen` closes it 4403 if realtime is off, so the SDK
 * surfaces a typed `CapabilityDisabledError` (§6.7.11 graceful degradation). Never
 * move a §12.0 invariant check into `onOpen`.
 */
export function canvasRealtimeRoutes(deps: CanvasRealtimeDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get(
    "/",
    deps.upgradeWebSocket((c) => {
      // canvas + user are resolved by the canvasApiRoutes middleware chain that
      // ran on the upgrade request (login + authorization already enforced).
      const canvas = requireCanvas(c);
      const user = c.get("user");
      let conn: Conn | null = null;

      return {
        onOpen(_evt, ws) {
          const socket: Socket = {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          };
          // Post-101 capability gate (feature flag, not a security boundary).
          if (!assertCapability(canvas, "realtime", deps.config)) {
            socket.send(
              JSON.stringify({
                type: "error",
                code: "CAPABILITY_DISABLED",
                capability: "realtime",
              }),
            );
            socket.close(CLOSE_CAPABILITY_DISABLED, "realtime disabled");
            return;
          }
          conn = deps.hub.connect(
            canvas.id,
            {
              id: user.id,
              name: user.name,
              isAdmin: user.isAdmin,
              orgIds: c.get("orgIds") ?? new Set<string>(),
              principal: requestPrincipal(c),
            },
            socket,
          );
          if (!conn) {
            socket.close(CLOSE_LIMIT, "connection limit");
            return;
          }
          // Metering (D24): a connect event, fire-and-forget (never fail the socket).
          void deps.usage
            .record({ canvasId: canvas.id, userId: user.id, type: "rt_connect" })
            .catch(() => {});
        },
        onMessage(evt) {
          if (!conn) return;
          const raw = typeof evt.data === "string" ? evt.data : "";
          if (raw) deps.hub.handleMessage(conn, raw);
        },
        onClose() {
          if (conn) deps.hub.disconnect(conn);
        },
        onError() {
          if (conn) deps.hub.disconnect(conn);
        },
      };
    }),
  );

  return app;
}
