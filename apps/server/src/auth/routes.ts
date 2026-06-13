import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import type { makeOidc } from "./oidc.js";
import type { SessionService } from "./session.js";

export interface AuthRoutesDeps {
  sessionSvc: SessionService;
  /** Present only in oidc mode. */
  oidc?: ReturnType<typeof makeOidc>;
}

/** Auth routes mounted at `/auth` (U11). `/login` + `/callback` are oidc-only. */
export function authRoutes(deps: AuthRoutesDeps) {
  const app = new Hono<AppEnv>();

  if (deps.oidc) {
    const { oidc } = deps;
    app.get("/login", (c) => oidc.login(c));
    app.get("/callback", (c) => oidc.callback(c));
  }

  app.get("/logout", async (c) => {
    await deps.sessionSvc.revoke(c);
    return c.redirect("/");
  });

  return app;
}
