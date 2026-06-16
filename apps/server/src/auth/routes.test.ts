import { describe, expect, it, vi } from "vitest";
import { authRoutes } from "./routes.js";
import type { SessionService } from "./session.js";

const stubSession: SessionService = {
  issue: async () => {},
  resolveUserId: async () => null,
  revoke: async () => {},
};

describe("authRoutes /logout", () => {
  it("revokes the session and redirects to /welcome (not /, which would re-challenge)", async () => {
    const revoke = vi.fn(async () => {});
    const app = authRoutes({ sessionSvc: { ...stubSession, revoke } });
    const res = await app.request("/logout");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/welcome");
    expect(revoke).toHaveBeenCalledOnce();
  });
});
