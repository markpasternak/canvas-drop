import {
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  Info,
  Monitor,
  MoonStars,
  ShieldCheck,
  SignOut,
  Sun,
  UserPlus,
} from "@phosphor-icons/react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { accountAvatarHue, SWITCHED_TO_KEY } from "../lib/account-avatar.js";
import { api, type Me, type SignedInAccount } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { useTheme } from "../lib/theme.js";
import { SegmentedControl } from "./SegmentedControl.js";

/** One focusable-element selector shared by the focus-trap and the focus-on-open
 * move, so the two can never disagree on what the menu's first/last focusable is. */
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** The menu's items, for the arrow-key navigation the ARIA menu pattern expects. */
const MENUITEM_SELECTOR = '[role="menuitem"]';

/** How many accounts one browser may hold when the server doesn't say (it always does). */
const DEFAULT_MAX_ACCOUNTS = 5;

type AccountList = { accounts: SignedInAccount[]; maxAccounts?: number };

/** First letter of the display name, falling back to the email — a calm avatar
 * fallback when the identity provider gives no `avatarUrl`. Tolerates a null/absent
 * name or email (some providers omit one). */
type AccountLike = Pick<Me, "email" | "avatarUrl"> & { name: string | null };

function initial(me: AccountLike): string {
  const source = me.name?.trim() || me.email?.trim() || "";
  return (source[0] ?? "?").toUpperCase();
}

/** Best display label for the account, never empty. */
function label(me: AccountLike): string {
  return me.name?.trim() || me.email?.trim() || "Account";
}

/** Account control in the top bar: an avatar button that opens a popover with the
 * signed-in identity, the theme switch, an About link, and (when the instance owns a
 * revocable session) Sign out. (Keyboard shortcuts stay available via the `?` global
 * binding — see Shortcuts — but are intentionally not linked here.)
 *
 * In `proxy` mode the trusted proxy owns identity and there is no app session to
 * revoke, so the menu omits Sign out and only surfaces who you are. Sign out is a
 * real navigation to the server `/auth/logout` redirect — not a fetch — so the
 * session cookie is cleared and the gateway re-challenges on the next load.
 *
 * `placement` controls which way the popover opens: the default `"down"` (used in
 * the mobile top bar) opens below the trigger; `"up"` opens above it, which the
 * left-rail footer needs — its trigger is pinned to the bottom of the viewport, so
 * a downward menu would fall below the fold. `expanded` swaps the compact
 * avatar-only trigger for a full-width row that also shows the display name (the
 * rail's expanded footer); the compact form stays for the collapsed rail and the
 * mobile bar.
 *
 * Multi-account (oidc only): under a "Switch account" heading the menu lists the other
 * accounts signed in on this browser (prefetched when the trigger is hovered or focused,
 * refreshed when it opens), then "Add another account" — which says so when one more
 * would sign out the least recently used account. Once there is more than one account,
 * sign-out names the account it affects ("Sign out of a@x") beside "Sign out of all
 * accounts". Switching and single sign-out are real same-origin form POSTs (the server
 * refuses them cross-origin), followed by a full page load as the new account, which
 * {@link useSwitchedAccountNotice} confirms with a toast. */
export function UserMenu({
  me,
  placement = "down",
  expanded = false,
  loadAccounts = api.otherAccounts,
}: {
  me: Me;
  placement?: "down" | "up";
  expanded?: boolean;
  /** Loads the other signed-in accounts; injectable for tests. */
  loadAccounts?: () => Promise<AccountList>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { choice, setChoice } = useTheme();
  const canSignOut = me.authMode !== "proxy";
  const multiAccount = me.authMode === "oidc";
  const [others, setOthers] = useState<SignedInAccount[]>([]);
  const [maxAccounts, setMaxAccounts] = useState(DEFAULT_MAX_ACCOUNTS);
  const openUp = placement === "up";
  const switchHeadingId = useId();

  // Load the other signed-in accounts when the pointer or focus reaches the trigger
  // (so the list and the sign-out labels are settled before the menu opens) and again
  // each time it opens (a sign-in in another tab may have added one). A failed load
  // just shows no other accounts. The loader is read through a ref so an inline prop
  // can't re-trigger the load; `mounted` drops a reply that lands after unmount.
  const loadAccountsRef = useRef(loadAccounts);
  loadAccountsRef.current = loadAccounts;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const lastLoad = useRef(0);
  const refreshAccounts = (force = false) => {
    if (!multiAccount) return;
    // Hover then click arrive within a moment of each other; one request covers both.
    if (!force && Date.now() - lastLoad.current < 2000) return;
    lastLoad.current = Date.now();
    loadAccountsRef
      .current()
      .then((list) => {
        if (!mounted.current) return;
        setOthers(list.accounts);
        if (list.maxAccounts) setMaxAccounts(list.maxAccounts);
      })
      .catch(() => mounted.current && setOthers([]));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh on open only.
  useEffect(() => {
    if (open) refreshAccounts();
  }, [open]);
  const signedInCount = others.length + 1;
  // Accounts come most recently used first, so the last one is the next to be dropped.
  const atLimit = multiAccount && others.length > 0 && signedInCount >= maxAccounts;
  const leastRecent = others[others.length - 1];

  // Arrow keys move between items (the ARIA menu pattern); Tab still reaches the theme
  // switch, which is a group of toggle buttons rather than menu items.
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(MENUITEM_SELECTOR) ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? (at + 1) % items.length
            : (at <= 0 ? items.length : at) - 1;
    items[next]?.focus();
  };

  // Close on outside pointerdown and on Escape; restore focus to the trigger so
  // keyboard users aren't dumped at the top of the document. While open, trap Tab
  // within the menu (and the trailing theme buttons) so keyboard nav can't strand
  // focus behind the popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Mark the key handled so document-level Escape listeners below this popover
        // (e.g. the canvas list's inline detail rail) don't also react to it.
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (e.key !== "Tab") return;
      const menu = menuRef.current;
      if (!menu) return;
      const focusables = menu.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // On open, move focus into the menu (its first item, else its first focusable
  // control) so keyboard users land inside the popover; the Escape handler above
  // restores focus to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    (
      menu?.querySelector<HTMLElement>(MENUITEM_SELECTOR) ??
      menu?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      menu
    )?.focus();
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", expanded && "w-full")}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onPointerEnter={() => refreshAccounts()}
        onFocus={() => refreshAccounts()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account: ${label(me)}`}
        className={cn(
          "flex h-9 items-center rounded-lg border border-border bg-surface-sunken text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:text-fg active:translate-y-px",
          // Expanded (rail) trigger is a real full-width row: avatar · name · caret.
          // Compact trigger (mobile bar / collapsed rail) stays avatar + caret only.
          expanded ? "w-full gap-2.5 px-1.5" : "gap-1.5 pr-1.5 pl-1",
          open && "text-fg",
        )}
      >
        <Avatar me={me} className="size-7" />
        {expanded && (
          <span className="min-w-0 flex-1 truncate text-left font-medium text-fg text-sm">
            {label(me)}
          </span>
        )}
        <CaretDown
          size={12}
          weight="bold"
          aria-hidden
          className={cn(
            "shrink-0 transition-transform duration-100",
            open && (openUp ? "rotate-0" : "rotate-180"),
            // Closed caret points toward where the menu will open.
            !open && openUp && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className={cn(
            "absolute z-40 w-60 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)]",
            // Open up (rail footer) vs. down (mobile bar). Horizontal alignment is
            // driven by the trigger's screen position, not just `expanded`:
            //   - expanded rail (left edge) → left-align, extend rightward.
            //   - collapsed rail (left edge, opens UP) → also left-align: the trigger
            //     is a narrow icon at the screen's LEFT, so right-aligning a 240px
            //     menu to it computes a negative left and shoves it off-screen.
            //   - mobile bar (right edge, opens DOWN) → right-align so the wider menu
            //     hugs the right edge and can't push off the right of the viewport.
            openUp ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]",
            expanded ? "left-0" : openUp ? "left-0" : "right-0",
            // Both up-opening triggers (expanded + collapsed rail) left-align, so the
            // grow origin is the bottom-left corner; the down-opening mobile bar
            // right-aligns and grows from the top-right.
            openUp ? "origin-bottom-left" : "origin-top-right",
          )}
        >
          <div className="flex items-center gap-3 border-border border-b px-3.5 py-3">
            <Avatar me={me} className="size-9 text-sm" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-fg text-sm">{label(me)}</span>
                {me.isAdmin && (
                  <ShieldCheck
                    size={14}
                    weight="fill"
                    aria-label="Admin"
                    className="shrink-0 text-accent"
                  />
                )}
              </div>
              {me.name?.trim() && me.email && (
                <div className="truncate text-subtle text-xs">{me.email}</div>
              )}
            </div>
            {/* With several accounts, mark which one this is. */}
            {others.length > 0 && (
              <CheckCircle
                size={18}
                weight="fill"
                aria-label="Current account"
                className="shrink-0 text-accent"
              />
            )}
          </div>

          {multiAccount && (
            <div className="border-border border-b py-1">
              {others.length > 0 && (
                // biome-ignore lint/a11y/useSemanticElements: a labelled group of menu items (ARIA menu pattern), not form fields.
                <div role="group" aria-labelledby={switchHeadingId}>
                  <div
                    id={switchHeadingId}
                    role="presentation"
                    className="px-3.5 pt-1.5 pb-1 font-medium text-[0.6875rem] text-subtle uppercase tracking-wider"
                  >
                    Switch account
                  </div>
                  {others.map((account) => (
                    <form
                      key={account.id}
                      method="post"
                      action="/auth/switch"
                      onSubmit={() => rememberSwitch(account)}
                    >
                      <input type="hidden" name="account" value={account.id} />
                      <button
                        type="submit"
                        role="menuitem"
                        aria-label={`Switch to ${account.email}`}
                        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
                      >
                        <Avatar me={account} className="size-7" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-fg text-sm">{label(account)}</span>
                          {account.name?.trim() && (
                            <span className="block truncate text-subtle text-xs">
                              {account.email}
                            </span>
                          )}
                        </span>
                      </button>
                    </form>
                  ))}
                </div>
              )}
              <a
                href="/auth/login?add=1"
                role="menuitem"
                aria-describedby={atLimit ? `${switchHeadingId}-limit` : undefined}
                className="flex items-center gap-2.5 px-3.5 py-2 text-fg text-sm transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
              >
                <UserPlus size={16} aria-hidden className="text-muted" />
                Add another account
              </a>
              {atLimit && leastRecent && (
                <p
                  id={`${switchHeadingId}-limit`}
                  className="px-3.5 pb-1.5 text-subtle text-xs leading-snug"
                >
                  You can be signed in to {maxAccounts} accounts at once. Adding another signs out{" "}
                  {leastRecent.email}.
                </p>
              )}
            </div>
          )}

          {/* Theme switch — a labeled row near the top, under the identity header.
              The SegmentedControl renders real aria-pressed toggle buttons, so the
              active theme is conveyed to assistive tech and each option is keyboard
              operable (Enter/Space). It lives here (not the rail footer) so the
              account menu is the single home for account-scoped preferences. */}
          <div className="flex items-center justify-between gap-2 border-border border-b px-3.5 py-2.5">
            <span className="text-fg text-sm">Theme</span>
            <SegmentedControl
              aria-label="Theme"
              size="sm"
              iconOnly
              value={choice}
              onChange={setChoice}
              items={[
                {
                  value: "system",
                  label: "Use system theme",
                  title: "Theme: System",
                  icon: Monitor,
                },
                { value: "light", label: "Use light theme", title: "Theme: Light", icon: Sun },
                { value: "dark", label: "Use dark theme", title: "Theme: Dark", icon: MoonStars },
              ]}
            />
          </div>

          {/* The server-rendered public landing — like Docs, it lives outside the SPA,
              so open it in a new tab with the same external-link affordance. */}
          <a
            href="/welcome"
            role="menuitem"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2.5 border-border border-t px-3.5 py-2.5 text-fg text-sm transition-colors hover:bg-surface-sunken"
          >
            <Info size={16} aria-hidden className="text-muted" />
            About canvas-drop
            <ArrowSquareOut size={13} weight="bold" aria-hidden className="ml-auto text-subtle" />
          </a>

          {canSignOut && others.length > 0 && (
            <form method="post" action="/auth/logout/current" className="border-border border-t">
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-2.5 px-3.5 pt-2.5 pb-1.5 text-left text-fg text-sm transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
              >
                <SignOut size={16} aria-hidden className="shrink-0 text-muted" />
                <span className="min-w-0 truncate">Sign out of {me.email || label(me)}</span>
              </button>
            </form>
          )}
          {canSignOut && (
            <a
              href="/auth/logout"
              role="menuitem"
              className={cn(
                "flex items-center gap-2.5 px-3.5 text-fg text-sm transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none",
                others.length > 0 ? "pt-1.5 pb-2.5" : "border-border border-t py-2.5",
              )}
            >
              <SignOut size={16} aria-hidden className="text-muted" />
              {others.length > 0 ? "Sign out of all accounts" : "Sign out"}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Avatar({ me, className }: { me: AccountLike; className?: string }) {
  if (me.avatarUrl) {
    return (
      <img
        src={me.avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-full bg-surface-sunken object-cover", className)}
      />
    );
  }
  // Each account gets its own tint (keyed by email), so two accounts with the same
  // initial — or the same name — still look different.
  return (
    <span
      aria-hidden
      style={{ "--avatar-hue": accountAvatarHue(me.email ?? "") } as CSSProperties}
      className={cn(
        "account-avatar grid shrink-0 place-items-center rounded-full font-semibold text-[0.8125rem]",
        className,
      )}
    >
      {initial(me)}
    </span>
  );
}

/** Leave the next page load a note of the account being switched to, for the toast. */
function rememberSwitch(account: SignedInAccount) {
  try {
    sessionStorage.setItem(SWITCHED_TO_KEY, account.email);
  } catch {
    // Storage blocked (private mode): the switch still happens, just without a notice.
  }
}

/**
 * After a switch (a full page load), confirm which account is now active — the main
 * risk with several accounts is acting as the wrong one. Call once, from the layout.
 * Shows nothing unless the note matches the account actually signed in now.
 */
export function useSwitchedAccountNotice(me: Me | undefined, notify: (message: string) => void) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per signed-in account.
  useEffect(() => {
    if (!me?.email) return;
    let switchedTo: string | null = null;
    try {
      switchedTo = sessionStorage.getItem(SWITCHED_TO_KEY);
      sessionStorage.removeItem(SWITCHED_TO_KEY);
    } catch {
      return;
    }
    if (switchedTo && switchedTo.toLowerCase() === me.email.toLowerCase()) {
      notify(`Now using ${me.email}`);
    }
  }, [me?.email]);
}
