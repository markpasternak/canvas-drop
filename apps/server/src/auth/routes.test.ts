import { describe, expect, it, vi } from "vitest";
import { authRoutes } from "./routes.js";
import type { SessionService } from "./session.js";

const stubSession: SessionService = {
  issue: async () => {},
  resolveUserId: async () => null,
  otherAccounts: async () => [],
  switchTo: async () => false,
  revoke: async () => ({ remaining: false }),
  revokeAll: async () => {},
  revokeHeld: async () => false,
};

describe("authRoutes /logout", () => {
  it("signs out of every account and redirects to /welcome (not /, which would re-challenge)", async () => {
    const revokeAll = vi.fn(async () => {});
    const app = authRoutes({ sessionSvc: { ...stubSession, revokeAll } });
    const res = await app.request("/logout");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/welcome");
    expect(revokeAll).toHaveBeenCalledOnce();
  });

  it("mounts no multi-account routes outside oidc mode", async () => {
    const app = authRoutes({ sessionSvc: stubSession });
    expect((await app.request("/accounts")).status).toBe(404);
    expect((await app.request("/switch", { method: "POST" })).status).toBe(404);
    expect((await app.request("/logout/current", { method: "POST" })).status).toBe(404);
  });
});
