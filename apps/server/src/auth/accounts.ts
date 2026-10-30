import { accountAvatarCss, accountAvatarHue, type Config } from "@canvas-drop/shared";
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

/** The first other signed-in account that may open `canvas` (or null), and whether the
 *  browser holds any other eligible account at all. A missing canvas (`null`) is probed
 *  the same way and always answers `accessibleAs: null`. */
export type OtherAccountProbe = (
  c: Context<AppEnv>,
  canvas: Canvas | null,
) => Promise<{ accessibleAs: AccountSummary | null; hasOtherAccounts: boolean }>;

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
    return {
      accessibleAs: first ? accountSummary(first) : null,
      hasOtherAccounts: candidates.length > 0,
    };
  };
}

function initial(user: AccountSummary): string {
  return ((user.name?.trim() || user.email.trim())[0] ?? "?").toUpperCase();
}

/** The account's photo when the identity provider gave one, else its tinted initial. */
function avatar(user: AccountSummary): string {
  if (user.avatarUrl && /^https:\/\//i.test(user.avatarUrl)) {
    return `<img class="avatar" src="${escapeAttribute(user.avatarUrl)}" alt="" referrerpolicy="no-referrer">`;
  }
  return `<span class="avatar avatar-h" style="--avatar-hue: ${accountAvatarHue(user.email)}" aria-hidden="true">${escapeHtml(initial(user))}</span>`;
}

function who(user: AccountSummary, badge?: string): string {
  const name = user.name?.trim();
  return `<span class="who">${name ? `<strong>${escapeHtml(name)}</strong>` : ""}<span>${escapeHtml(user.email)}</span>${badge ? `<em class="badge">${badge}</em>` : ""}</span>`;
}

const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * One chooser row. Every row does the same thing — continue as that account — so the
 * current account is a plain link back to where the visitor was headed, and the others
 * are same-origin switch forms. Other accounts also get their own Sign out.
 */
function accountRow(
  user: AccountSummary,
  opts: { current?: boolean; returnTo?: string; picked?: boolean },
): string {
  const returnField = opts.returnTo
    ? `<input type="hidden" name="returnTo" value="${escapeAttribute(opts.returnTo)}">`
    : "";
  if (opts.current) {
    return `<li class="row current">
          <a class="pick" href="${escapeAttribute(opts.returnTo ?? "/")}" aria-label="Continue as ${escapeAttribute(user.email)} (current account)">${avatar(user)}${who(user)}<span class="tag">Current</span>${CHEVRON}</a>
          <span class="out-spacer" aria-hidden="true"></span>
        </li>`;
  }
  return `<li class="row${opts.picked ? " picked" : ""}">
          <form class="pick-form" method="POST" action="/auth/switch">
            <input type="hidden" name="account" value="${escapeAttribute(user.id)}">
            ${returnField}
            <button class="pick" type="submit"${opts.picked ? " autofocus" : ""} aria-label="Continue as ${escapeAttribute(user.email)}">${avatar(user)}${who(user, opts.picked ? "Can open this canvas" : undefined)}${CHEVRON}</button>
          </form>
          <form class="out-form" method="POST" action="/auth/logout/account">
            <input type="hidden" name="account" value="${escapeAttribute(user.id)}">
            ${returnField}
            <button class="out" type="submit" aria-label="Sign out of ${escapeAttribute(user.email)}">Sign out</button>
          </form>
        </li>`;
}

/**
 * The account chooser page (`GET /auth/accounts`). Server-rendered on the app origin so
 * its switch forms are same-origin POSTs: a canvas (its own origin in subdomain mode)
 * can link here but can never switch the visitor's account by itself.
 *
 * Layout: the suggested account (the canvas 404's "Switch to …" target) leads, marked
 * "Can open this canvas"; otherwise the current account leads. Every row continues as
 * its account; other accounts carry their own Sign out. "Add another account" says so
 * when one more would sign out the least recently used account.
 */
export function accountChooserPage(input: {
  config: Config;
  current: AccountSummary;
  /** The other accounts, most recently used first. */
  others: AccountSummary[];
  returnTo?: string;
  /** Account to put first and focus (the canvas 404's "Switch to …" target). */
  preselect?: string;
  /** Most accounts one browser may hold (adding past it drops the least recently used). */
  maxAccounts?: number;
}): string {
  const { config, current, returnTo } = input;
  const picked = input.others.find((o) => o.id === input.preselect);
  const rest = input.others.filter((o) => o !== picked);
  const rows = [
    ...(picked ? [accountRow(picked, { returnTo, picked: true })] : []),
    accountRow(current, { current: true, returnTo }),
    ...rest.map((o) => accountRow(o, { returnTo })),
  ].join("\n        ");
  const addHref = escapeAttribute(addAccountUrl(config, returnTo));
  const backHref = escapeAttribute(returnTo ?? "/");
  const leastRecent = input.others[input.others.length - 1];
  const atLimit =
    !!input.maxAccounts && !!leastRecent && input.others.length + 1 >= input.maxAccounts;
  const limitNote = atLimit
    ? `<p class="note" id="limit-note">You can be signed in to ${input.maxAccounts} accounts at once. Adding another signs out ${escapeHtml(leastRecent.email)}.</p>`
    : "";
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
  .lede strong { color: var(--fg); font-weight: 600; }
  ul { display: flex; flex-direction: column; gap: .5rem; list-style: none; margin: 0; padding: 0; }
  .row {
    display: flex; align-items: center; gap: .25rem;
    border: 1px solid var(--border); border-radius: .75rem; background: var(--surface);
  }
  .row.picked { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .row form { margin: 0; }
  .pick-form { display: flex; min-width: 0; flex: 1; }
  .pick {
    display: flex; width: 100%; min-width: 0; flex: 1; align-items: center; gap: .75rem;
    padding: .75rem .85rem; border: 0; border-radius: .75rem; background: none; color: var(--fg);
    font: inherit; text-align: left; text-decoration: none; cursor: pointer;
  }
  .pick:hover { background: var(--surface-sunken); }
  .pick:focus-visible, .out:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .avatar {
    display: inline-grid; place-items: center; flex: none; width: 2.25rem; height: 2.25rem;
    border-radius: 999px; object-fit: cover; font-weight: 650; font-size: .9rem;
  }
${accountAvatarCss(".avatar-h")}
  .who { display: flex; min-width: 0; flex: 1; flex-direction: column; font-size: .875rem; }
  .who span { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
  .who strong { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .badge { margin-top: .2rem; color: var(--accent); font-size: .75rem; font-style: normal; font-weight: 650; }
  .tag { flex: none; padding: .15rem .5rem; border-radius: 999px; background: var(--surface-sunken); color: var(--muted); font-size: .7rem; font-weight: 600; }
  .chev { flex: none; color: var(--subtle); }
  /* Fixed width (and a matching spacer on the current row) keeps every chevron aligned. */
  .out, .out-spacer { flex: none; width: 4.25rem; margin-right: .5rem; }
  .out {
    padding: .4rem .6rem; border: 0; border-radius: .5rem;
    background: none; color: var(--subtle); font: inherit; font-size: .75rem; font-weight: 600; cursor: pointer;
  }
  .out:hover { background: var(--surface-sunken); color: var(--fg); }
  .actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.25rem; }
  .actions a {
    display: inline-flex; min-height: 2.5rem; align-items: center; padding: .6rem .95rem;
    border: 1px solid var(--border); border-radius: .5rem; color: var(--fg);
    font-size: .875rem; font-weight: 650; text-decoration: none;
  }
  .actions a:hover { background: var(--surface-sunken); }
  .actions a.quiet { border-color: transparent; color: var(--muted); }
  .note { margin: .75rem 0 0; color: var(--subtle); font-size: .8rem; }
</style>
</head>
<body>
  <main>
${SYSTEM_PAGE_BRAND}
    <section class="content">
      <h1>Choose an account</h1>
      <p class="lede">${picked ? `<strong>${escapeHtml(picked.email)}</strong> can open this canvas.` : "Continue with an account you're signed in to, or add another."}</p>
      <ul>
        ${rows}
      </ul>
      <div class="actions">
        <a href="${addHref}"${atLimit ? ' aria-describedby="limit-note"' : ""}>Add another account</a>
        <a class="quiet" href="${backHref}">Back</a>
      </div>
      ${limitNote}
    </section>
  </main>
</body>
</html>`;
}
