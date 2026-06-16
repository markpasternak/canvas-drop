import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { describe, expect, it } from "vitest";
import {
  CLOSE_CAPABILITY_DISABLED,
  CLOSE_UNAUTHORIZED,
  type Conn,
  type ConnUser,
  createHub,
  MAX_CONNECTIONS_PER_CANVAS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_MIN,
  type Socket,
} from "./hub.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" }); // realtime on by default

class FakeSocket implements Socket {
  sent: Array<Record<string, unknown>> = [];
  closed: { code: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason?: string): void {
    this.closed = { code, reason };
  }
  /** Messages of a given type. */
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

function fakeCanvas(over: Partial<Canvas> = {}): Canvas {
  return {
    id: "c1",
    ownerId: "owner",
    slug: "app",
    status: "active",
    shared: true,
    sharedExpiresAt: null,
    passwordHash: null,
    backendEnabled: true,
    capKv: true,
    capFiles: true,
    capAi: true,
    capRealtime: true,
    ...over,
  } as unknown as Canvas;
}

const user = (id: string, isAdmin = false): ConnUser => ({ id, name: id, isAdmin });

function makeHub(
  canvas: Canvas | null = fakeCanvas(),
  isUserActive?: (id: string) => Promise<boolean>,
  isPrincipalAllowed?: (
    canvasId: string,
    p: { userId?: string; email?: string },
  ) => Promise<boolean>,
) {
  return createHub({
    config,
    resolveCanvas: async () => canvas,
    isUserActive,
    isPrincipalAllowed,
  });
}

/** Connect and assert the per-canvas limit wasn't hit (keeps tests assertion-free of `!`). */
function mc(hub: ReturnType<typeof makeHub>, canvasId: string, u: ConnUser, sock: Socket): Conn {
  const c = hub.connect(canvasId, u, sock);
  if (!c) throw new Error("connect returned null (unexpected limit)");
  return c;
}

describe("RealtimeHub", () => {
  it("fans out a publish to all subscribers of a channel in the same canvas", () => {
    const hub = makeHub();
    const sa = new FakeSocket();
    const sb = new FakeSocket();
    const a = mc(hub, "c1", user("ua"), sa);
    const b = mc(hub, "c1", user("ub"), sb);
    hub.handleMessage(a, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.handleMessage(b, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.handleMessage(
      a,
      JSON.stringify({ type: "publish", channel: "room", event: "msg", data: { x: 1 } }),
    );

    const bMsg = sb.ofType("message");
    expect(bMsg).toHaveLength(1);
    expect(bMsg[0]).toMatchObject({
      channel: "room",
      event: "msg",
      data: { x: 1 },
      from: { id: "ua" },
    });
  });

  it("isolates canvases — a publish in canvas A never reaches canvas B (same channel name)", () => {
    const hub = makeHub();
    const sa = new FakeSocket();
    const sb = new FakeSocket();
    const a = mc(hub, "canvasA", user("ua"), sa);
    const b = mc(hub, "canvasB", user("ub"), sb);
    hub.handleMessage(a, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.handleMessage(b, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.handleMessage(a, JSON.stringify({ type: "publish", channel: "room", event: "x", data: 1 }));

    expect(sb.ofType("message")).toHaveLength(0); // cross-canvas isolation (§12.0 #4)
  });

  it("from is the server identity even if the client tries to spoof it", () => {
    const hub = makeHub();
    const sa = new FakeSocket();
    const sb = new FakeSocket();
    const a = mc(hub, "c1", user("ua"), sa);
    const b = mc(hub, "c1", user("ub"), sb);
    hub.handleMessage(b, JSON.stringify({ type: "subscribe", channel: "room" }));
    // client puts a bogus `from` in the frame; it must be ignored
    hub.handleMessage(
      a,
      JSON.stringify({
        type: "publish",
        channel: "room",
        event: "x",
        data: 1,
        from: { id: "admin" },
      }),
    );
    expect(sb.ofType("message")[0]?.from).toEqual({ id: "ua", name: "ua" });
  });

  it("presence dedupes per user across tabs and emits join/leave once", () => {
    const hub = makeHub();
    const watcher = new FakeSocket();
    const w = mc(hub, "c1", user("watcher"), watcher);
    hub.handleMessage(w, JSON.stringify({ type: "subscribe", channel: "room" }));

    // user "u" connects twice (two tabs)
    const t1 = mc(hub, "c1", user("u"), new FakeSocket());
    const t2 = mc(hub, "c1", user("u"), new FakeSocket());
    hub.handleMessage(t1, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.handleMessage(t2, JSON.stringify({ type: "subscribe", channel: "room" }));

    // watcher saw exactly one join for "u" (deduped)
    expect(
      watcher.ofType("join").filter((j) => (j.user as { id: string }).id === "u"),
    ).toHaveLength(1);
    // presence lists watcher + u once each
    expect(
      hub
        .presence("c1", "room")
        .map((p) => p.id)
        .sort(),
    ).toEqual(["u", "watcher"]);

    // first tab leaves → no leave yet (other tab still present)
    hub.handleMessage(t1, JSON.stringify({ type: "unsubscribe", channel: "room" }));
    expect(watcher.ofType("leave")).toHaveLength(0);
    // second tab leaves → leave fires once
    hub.handleMessage(t2, JSON.stringify({ type: "unsubscribe", channel: "room" }));
    expect(
      watcher.ofType("leave").filter((l) => (l.user as { id: string }).id === "u"),
    ).toHaveLength(1);
  });

  it("rejects the connection over the per-canvas limit", () => {
    const hub = makeHub();
    for (let i = 0; i < MAX_CONNECTIONS_PER_CANVAS; i++) {
      expect(hub.connect("c1", user(`u${i}`), new FakeSocket())).not.toBeNull();
    }
    expect(hub.connect("c1", user("overflow"), new FakeSocket())).toBeNull();
  });

  it("rate-limits a user past the per-minute cap (drops + error frame)", () => {
    const hub = makeHub();
    const s = new FakeSocket();
    const a = mc(hub, "c1", user("ua"), s);
    hub.handleMessage(a, JSON.stringify({ type: "subscribe", channel: "room" }));
    const now = 1_000_000;
    for (let i = 0; i < MAX_MESSAGES_PER_MIN; i++) {
      hub.handleMessage(
        a,
        JSON.stringify({ type: "publish", channel: "room", event: "x", data: i }),
        now,
      );
    }
    // one over the cap, same window
    hub.handleMessage(
      a,
      JSON.stringify({ type: "publish", channel: "room", event: "x", data: "over" }),
      now,
    );
    expect(s.ofType("error").some((e) => e.code === "RATE_LIMITED")).toBe(true);
    // exactly MAX delivered to self (subscriber), the 101st dropped
    expect(s.ofType("message")).toHaveLength(MAX_MESSAGES_PER_MIN);
  });

  it("rejects an oversized frame (>16KB)", () => {
    const hub = makeHub();
    const s = new FakeSocket();
    const a = mc(hub, "c1", user("ua"), s);
    const big = "x".repeat(MAX_MESSAGE_BYTES + 1);
    hub.handleMessage(
      a,
      JSON.stringify({ type: "publish", channel: "room", event: "x", data: big }),
    );
    expect(s.ofType("error").some((e) => e.code === "MESSAGE_TOO_LARGE")).toBe(true);
  });

  it("revalidateCanvas drops a non-owner when the canvas is un-shared, keeps the owner", async () => {
    const hub = makeHub(fakeCanvas({ access: "private" }));
    const ownerSock = new FakeSocket();
    const viewerSock = new FakeSocket();
    mc(hub, "c1", user("owner"), ownerSock); // ownerId = "owner"
    mc(hub, "c1", user("viewer"), viewerSock);
    await hub.revalidateCanvas("c1");
    expect(viewerSock.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(ownerSock.closed).toBeNull();
  });

  it("revalidateCanvas drops everyone when the realtime capability is turned off", async () => {
    const hub = makeHub(fakeCanvas({ capRealtime: false }));
    const ownerSock = new FakeSocket();
    mc(hub, "c1", user("owner"), ownerSock);
    await hub.revalidateCanvas("c1");
    expect(ownerSock.closed?.code).toBe(CLOSE_CAPABILITY_DISABLED);
  });

  it("revalidateCanvas drops a blocked/deleted user via isUserActive", async () => {
    const blocked = new Set(["badguy"]);
    const hub = makeHub(fakeCanvas(), async (id) => !blocked.has(id));
    const ownerSock = new FakeSocket();
    const badSock = new FakeSocket();
    mc(hub, "c1", user("owner"), ownerSock);
    mc(hub, "c1", user("badguy"), badSock);
    await hub.revalidateCanvas("c1");
    expect(badSock.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(ownerSock.closed).toBeNull();
  });

  it("revalidateCanvas drops a non-owner socket when the canvas becomes public_link (static-only), keeps the owner", async () => {
    // public_link is static-only for non-owners: no realtime. A live socket from
    // before the rung change must be dropped instantly (§12.0 #5 lifecycle).
    const hub = makeHub(fakeCanvas({ access: "public_link" }));
    const ownerSock = new FakeSocket();
    const viewerSock = new FakeSocket();
    mc(hub, "c1", user("owner"), ownerSock);
    mc(hub, "c1", user("viewer"), viewerSock);
    await hub.revalidateCanvas("c1");
    expect(viewerSock.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(ownerSock.closed).toBeNull();
  });

  it("revalidateCanvas fails closed (drops the socket) when isPrincipalAllowed throws", async () => {
    // A transient DB error during re-auth must drop the socket (deny), never leave a
    // stale grant alive, and never abort the rest of the sweep.
    const hub = makeHub(fakeCanvas({ access: "specific_people" }), undefined, async () => {
      throw new Error("db down");
    });
    const ownerSock = new FakeSocket();
    const viewerSock = new FakeSocket();
    mc(hub, "c1", user("owner"), ownerSock); // owner bypasses the allowlist check
    mc(hub, "c1", user("viewer"), viewerSock);
    await hub.revalidateCanvas("c1");
    expect(viewerSock.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(ownerSock.closed).toBeNull();
  });

  it("revalidateCanvas fails closed (drops sockets) when isUserActive throws, without aborting the sweep", async () => {
    const hub = makeHub(fakeCanvas({ access: "whole_org" }), async () => {
      throw new Error("db down");
    });
    const ownerSock = new FakeSocket();
    const viewerSock = new FakeSocket();
    mc(hub, "c1", user("owner"), ownerSock);
    mc(hub, "c1", user("viewer"), viewerSock);
    await hub.revalidateCanvas("c1");
    // Both reach the isUserActive stage (whole_org admits members); a throw drops
    // each rather than aborting the loop or leaving a stale grant.
    expect(ownerSock.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(viewerSock.closed?.code).toBe(CLOSE_UNAUTHORIZED);
  });

  it("revalidateCanvas drops everyone when the canvas is gone", async () => {
    const hub = makeHub(null);
    const s = new FakeSocket();
    mc(hub, "c1", user("owner"), s);
    await hub.revalidateCanvas("c1");
    expect(s.closed?.code).toBe(CLOSE_UNAUTHORIZED);
  });

  it("dropGatedNonOwners closes every non-owner, including an admin (admins face the gate)", async () => {
    const hub = makeHub(fakeCanvas());
    const ownerSock = new FakeSocket();
    const adminSock = new FakeSocket();
    const viewerSock = new FakeSocket();
    mc(hub, "c1", user("owner"), ownerSock);
    mc(hub, "c1", user("anAdmin", true), adminSock);
    mc(hub, "c1", user("viewer"), viewerSock);
    await hub.dropGatedNonOwners("c1");
    expect(viewerSock.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    // A non-owner admin gets no password bypass — its socket is dropped too.
    expect(adminSock.closed?.code).toBe(CLOSE_UNAUTHORIZED);
    expect(ownerSock.closed).toBeNull();
  });

  it("a throwing socket in a broadcast does not starve the other subscribers", () => {
    const hub = makeHub();
    // First subscriber's send throws (dead socket); second must still receive.
    const deadSock = new FakeSocket();
    deadSock.send = () => {
      throw new Error("WebSocket is not open");
    };
    const liveSock = new FakeSocket();
    const dead = mc(hub, "c1", user("dead"), deadSock);
    const live = mc(hub, "c1", user("live"), liveSock);
    const publisher = mc(hub, "c1", user("pub"), new FakeSocket());
    hub.handleMessage(dead, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.handleMessage(live, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.handleMessage(
      publisher,
      JSON.stringify({ type: "publish", channel: "room", event: "x", data: 1 }),
    );
    expect(liveSock.ofType("message")).toHaveLength(1); // not starved by the dead socket
  });

  it("disconnect emits a leave to remaining channel members", () => {
    const hub = makeHub();
    const sa = new FakeSocket();
    const sb = new FakeSocket();
    const a = mc(hub, "c1", user("ua"), sa);
    const b = mc(hub, "c1", user("ub"), sb);
    hub.handleMessage(a, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.handleMessage(b, JSON.stringify({ type: "subscribe", channel: "room" }));
    hub.disconnect(a);
    expect(sb.ofType("leave").some((l) => (l.user as { id: string }).id === "ua")).toBe(true);
    expect(hub.connectionCount("c1")).toBe(1);
  });
});
