import { type Context, Hono } from "hono";
import { isSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import { resolveRequest } from "../routing/resolve-request.js";
import {
  type AccountsDeps,
  accountChooserPage,
  accountSummary,
  canSignInNow,
  otherSignedInAccounts,
} from "./accounts.js";
import type { makeOidc } from "./oidc.js";
import { accountChooserUrl, addAccountUrl, loginUrl, safeReturnTo } from "./return-to.js";
import { MAX_OTHER_ACCOUNTS, type SessionService } from "./session.js";

export interface AuthRoutesDeps {
  sessionSvc: SessionService;
  /** Present only in oidc mode. */
  oidc?: ReturnType<typeof makeOidc>;
  /** Multi-account switching (oidc mode only — the routes below are absent otherwise). */
  accounts?: AccountsDeps;
}

/**
 * Auth routes mounted at `/auth` (U11). `/login` + `/callback` are oidc-only, and so
 * is the multi-account surface (`/accounts`, `/switch`, `/logout/current`, `/logout/account`): in proxy
 * mode the IAP owns identity and in dev mode it is fixed by config, so there is no
 * second account to switch to.
 */
export function authRoutes(deps: AuthRoutesDeps) {
  const app = new Hono<AppEnv>();

  if (deps.oidc) {
    const { oidc } = deps;
    app.get("/login", (c) => oidc.login(c));
    app.get("/callback", (c) => oidc.callback(c));
  }

  // Sign out of EVERY account on this browser (the classic "Sign out"). A GET for the
  // plain links on error pages and the dashboard, so a cross-site navigation here is
  // ignored rather than signing the visitor out of every account.
  app.get("/logout", async (c) => {
    if (c.req.header("sec-fetch-site") === "cross-site") return c.redirect("/");
    await deps.sessionSvc.revokeAll(c);
    // Land on the public welcome page (always-on landing alias) rather than `/`,
    // which would re-challenge the now-signed-out visitor straight into login.
    return c.redirect("/welcome");
  });

  const accounts = deps.accounts;
  if (accounts) {
    const { config, sessionSvc } = accounts;
    // `/auth` answers on canvas subdomains too (sign-in starts from the canvas's own
    // origin), so there a canvas page's own fetch is "same-origin". Changing who the
    // browser is signed in as happens only on the instance host.
    const onCanvasHost = (c: Context<AppEnv>) =>
      resolveRequest({ host: c.req.header("host") ?? "", pathname: c.req.path }, config).role ===
      "canvas";
    const mayChangeAccount = (c: Context<AppEnv>) => !onCanvasHost(c) && isSameOrigin(c, config);

    // The account chooser. Pre-gateway like the rest of /auth, so it resolves the
    // active account itself; with none, the visitor simply signs in.
    app.get("/accounts", async (c) => {
      const returnTo = safeReturnTo(config, c.req.query("returnTo"));
      if (onCanvasHost(c)) {
        return c.redirect(accountChooserUrl(config, returnTo, c.req.query("account")));
      }
      const activeId = await sessionSvc.resolveUserId(c);
      const active = activeId ? await accounts.users.findById(activeId) : null;
      if (!active) return c.redirect(loginUrl(config, returnTo));
      const others = await otherSignedInAccounts(accounts, c);
      if (others.length === 0) return c.redirect(addAccountUrl(config, returnTo));
      c.header("Cache-Control", "no-store");
      // A canvas (same-site in subdomain mode, so the session rides along) must not
      // frame the chooser and steer a click onto "Continue as".
      c.header("Content-Security-Policy", "frame-ancestors 'none'");
      return c.html(
        accountChooserPage({
          config,
          current: accountSummary(active),
          others: others.map(accountSummary),
          returnTo,
          preselect: c.req.query("account"),
          maxAccounts: MAX_OTHER_ACCOUNTS + 1,
        }),
      );
    });

    // Switch the active account. Same-origin POST on the instance host only: a canvas
    // page can link to the chooser but can't flip the account itself.
    app.post("/switch", async (c) => {
      if (!mayChangeAccount(c)) return c.json({ error: "cross_origin_forbidden" }, 403);
      const form = await c.req.parseBody();
      const field = (name: string) => (typeof form[name] === "string" ? form[name] : undefined);
      const returnTo = safeReturnTo(config, field("returnTo"));
      const account = field("account");
      // Only an account that could pass the gateway right now is switchable.
      const target = account ? await accounts.users.findById(account) : null;
      const eligible =
        !!target && (await canSignInNow(target, config, accounts.allowedEmails, c.get("log")));
      if (!target || !eligible || !(await sessionSvc.switchTo(c, target.id))) {
        return c.redirect(accountChooserUrl(config, returnTo), 303);
      }
      return c.redirect(returnTo ?? "/", 303);
    });

    // Sign out of one other account this browser holds (the chooser's per-row Sign out).
    // The active account stays. Back to the chooser while there is still someone to
    // choose, else straight on to where the visitor was headed.
    app.post("/logout/account", async (c) => {
      if (!mayChangeAccount(c)) return c.json({ error: "cross_origin_forbidden" }, 403);
      const form = await c.req.parseBody();
      const field = (name: string) => (typeof form[name] === "string" ? form[name] : undefined);
      const returnTo = safeReturnTo(config, field("returnTo"));
      const account = field("account");
      if (account) await sessionSvc.revokeHeld(c, account);
      const remaining = await otherSignedInAccounts(accounts, c);
      return c.redirect(
        remaining.length > 0 ? accountChooserUrl(config, returnTo) : (returnTo ?? "/"),
        303,
      );
    });

    // Sign out of the active account only; the next signed-in account takes over.
    app.post("/logout/current", async (c) => {
      if (!mayChangeAccount(c)) return c.json({ error: "cross_origin_forbidden" }, 403);
      const { remaining } = await sessionSvc.revoke(c);
      return c.redirect(remaining ? "/" : "/welcome", 303);
    });
  }

  return app;
}
