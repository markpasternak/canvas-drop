import type { Config } from "@canvas-drop/shared";
import type { Canvas, User } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { decideAccessFor, memberPrincipal } from "../canvas/authorization.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import {
  escapeAttribute,
  escapeHtml,
  SYSTEM_PAGE_BRAND,
  SYSTEM_PAGE_STYLES,
  SYSTEM_THEME_INIT,
} from "../http/error-pages.js";
import type { AppEnv } from "../http/types.js";
import type { Logger } from "../log/logger.js";
import { isEmailAllowed } from "./identity-mapping.js";
import type { OrgMembershipResolver } from "./org-membership.js";
import { addAccountUrl } from "./return-to.js";
import type { SessionService } from "./session.js";

/**
 * Multi-account sign-in (oidc mode): the account switcher's server side.
 *
 * Every account on a browser is an ordinary app session (see session.ts, the
 * account jar), so these helpers only ever read accounts the browser already holds
 * a live session for. An account that could not pass the gateway right now (blocked,
 * or no longer on the sign-in allowlist) is left out everywhere, so the switcher
 * never offers a dead end and the canvas probe never answers for it.
 */

/** Profile fields the switcher shows. An explicit projection, never the user row. */
export interface AccountSummary {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface AccountsDeps {
  config: Config;
  sessionSvc: SessionService;
  users: Pick<UsersRepository, "findById">;
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">;
}

export function accountSummary(user: User): AccountSummary {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl ?? null };
}

/** Whether `user` could pass the gateway right now: not blocked, still allowed to sign in. */
export async function canSignInNow(
  user: User,
  config: Config,
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">,
  log?: Logger,
): Promise<boolean> {
  return !user.isBlocked && (await isEmailAllowed(user.email, config, allowedEmails, log));
}

/** The session service's eligibility hook (never list, switch to or promote a held
 *  account the gateway would refuse). */
export function makeAccountEligibility(
  config: Config,
  users: Pick<UsersRepository, "findById">,
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">,
): (userId: string) => Promise<boolean> {
  return async (userId) => {
    const user = await users.findById(userId);
    return !!user && (await canSignInNow(user, config, allowedEmails));
  };
}

/** The OTHER signed-in accounts on this browser that could sign in right now. */
export async function otherSignedInAccounts(
  deps: AccountsDeps,
  c: Context<AppEnv>,
): Promise<User[]> {
  const held = await deps.sessionSvc.otherAccounts(c);
  const users = await Promise.all(held.map(({ userId }) => deps.users.findById(userId)));
  const ok = await Promise.all(
    users.map((u) => !!u && canSignInNow(u, deps.config, deps.allowedEmails, c.get("log"))),
  );
  return users.filter((u, i): u is User => !!u && ok[i] === true);
}

/** Summaries of {@link otherSignedInAccounts}, for `/api/me/accounts`. */
export async function otherAccountSummaries(
  deps: AccountsDeps,
  c: Context<AppEnv>,
): Promise<AccountSummary[]> {
  return (await otherSignedInAccounts(deps, c)).map(accountSummary);
}

export interface AccountProbeDeps extends AccountsDeps {
  canvases: CanvasesRepository;
  teams: Pick<TeamsRepository, "teamMatch">;
  orgMembership: OrgMembershipResolver;
  tenancyActive: boolean;
  publicLinksEnabled?: () => Promise<boolean>;
}

/** The first other signed-in account that may open `canvas`, or null. A missing canvas
 *  (`null`) is probed the same way and always answers null. */
export type OtherAccountProbe = (
  c: Context<AppEnv>,
  canvas: Canvas | null,
) => Promise<AccountSummary | null>;

/**
 * Build the "another of your accounts can open this" probe used on a canvas 404.
 *
 * Each candidate is judged by the SAME decision canvasAccess would make if that account
 * were active ({@link decideAccessFor} over its server-derived org membership). Only
 * accounts this browser already holds a live session for are probed, so the answer only
 * ever tells the person something they could learn by switching. A password gate is
 * irrelevant here: an allow that still needs the password is still worth switching for.
 */
export function makeOtherAccountProbe(deps: AccountProbeDeps): OtherAccountProbe {
  return async (c, canvas) => {
    const candidates = await otherSignedInAccounts(deps, c);
    const allowed = await Promise.all(
      candidates.map(async (user) => {
        const principal = memberPrincipal(user, await deps.orgMembership(user));
        return (await decideAccessFor(deps, canvas, principal)).action === "allow";
      }),
    );
    const first = candidates.find((_, i) => allowed[i]);
    return first ? accountSummary(first) : null;
  };
}

function initial(user: AccountSummary): string {
  return ((user.name?.trim() || user.email.trim())[0] ?? "?").toUpperCase();
}

function accountRow(
  user: AccountSummary,
  opts: { current?: boolean; returnTo?: string; focus?: boolean },
): string {
  const name = user.name?.trim();
  const who = `<span class="avatar" aria-hidden="true">${escapeHtml(initial(user))}</span>
          <span class="who">${name ? `<strong>${escapeHtml(name)}</strong>` : ""}<span>${escapeHtml(user.email)}</span></span>`;
  if (opts.current) {
    return `<li class="row current">${who}<span class="tag">Current</span></li>`;
  }
  return `<li class="row">
          <form method="POST" action="/auth/switch">
            <input type="hidden" name="account" value="${escapeAttribute(user.id)}">
            ${opts.returnTo ? `<input type="hidden" name="returnTo" value="${escapeAttribute(opts.returnTo)}">` : ""}
            <button type="submit"${opts.focus ? " autofocus" : ""} aria-label="Continue as ${escapeAttribute(user.email)}">${who}<span class="go">${opts.focus ? "Continue" : "Switch"}</span></button>
          </form>
        </li>`;
}

/**
 * The account chooser page (`GET /auth/accounts`). Server-rendered on the app origin so
 * its switch forms are same-origin POSTs: a canvas (its own origin in subdomain mode)
 * can link here but can never switch the visitor's account by itself.
 */
export function accountChooserPage(input: {
  config: Config;
  current: AccountSummary;
  others: AccountSummary[];
  returnTo?: string;
  /** Account to put first and focus (the canvas 404's "Continue as …" target). */
  preselect?: string;
}): string {
  const { config, current, returnTo } = input;
  const picked = input.others.find((o) => o.id === input.preselect);
  const others = picked ? [picked, ...input.others.filter((o) => o !== picked)] : input.others;
  const rows = [
    ...others.map((o) => accountRow(o, { returnTo, focus: o === picked })),
    accountRow(current, { current: true }),
  ].join("\n        ");
  const addHref = escapeAttribute(addAccountUrl(config, returnTo));
  const backHref = escapeAttribute(returnTo ?? "/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex">
<title>Choose an account</title>
${SYSTEM_THEME_INIT}
<style>
${SYSTEM_PAGE_STYLES}
  main { width: min(100%, 30rem); }
  h1 { margin: 0; color: var(--fg); font-family: var(--font-serif); font-optical-sizing: auto; font-weight: 500; font-size: 1.75rem; line-height: 1.2; letter-spacing: -.015em; }
  .lede { margin: .5rem 0 1.25rem; color: var(--muted); font-size: .9rem; }
  ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
  .row { border-bottom: 1px solid var(--border); }
  .row form { margin: 0; }
  .row button, .row.current {
    display: flex; width: 100%; align-items: center; gap: .75rem;
    padding: .75rem .5rem; border: 0; background: none; color: var(--fg);
    font: inherit; text-align: left;
  }
  .row button { cursor: pointer; border-radius: .5rem; }
  .row button:hover { background: var(--surface-sunken); }
  .row button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .avatar {
    display: inline-grid; place-items: center; flex: none; width: 2rem; height: 2rem;
    border-radius: 999px; background: var(--accent-subtle); color: var(--accent);
    font-weight: 650; font-size: .85rem;
  }
  .who { display: flex; min-width: 0; flex: 1; flex-direction: column; font-size: .875rem; }
  .who span { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
  .who strong { font-weight: 600; }
  .go { color: var(--accent); font-size: .85rem; font-weight: 650; }
  .tag { color: var(--subtle); font-size: .75rem; }
  .actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.25rem; }
  .actions a {
    display: inline-flex; min-height: 2.5rem; align-items: center; padding: .6rem .95rem;
    border: 1px solid var(--border); border-radius: .5rem; color: var(--fg);
    font-size: .875rem; font-weight: 650; text-decoration: none;
  }
  .actions a:hover { background: var(--surface-sunken); }
  .actions a.quiet { border-color: transparent; color: var(--muted); }
</style>
</head>
<body>
  <main>
${SYSTEM_PAGE_BRAND}
    <section class="content">
      <h1>Choose an account</h1>
      <p class="lede">${picked ? `Continue as ${escapeHtml(picked.email)}?` : "Switch to another account you're signed in with, or add one."}</p>
      <ul>
        ${rows}
      </ul>
      <div class="actions">
        <a href="${addHref}">Add another account</a>
        <a class="quiet" href="${backHref}">Cancel</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}
