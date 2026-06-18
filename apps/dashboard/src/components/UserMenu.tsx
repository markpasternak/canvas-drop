import {
  ArrowSquareOut,
  CaretDown,
  Info,
  Monitor,
  MoonStars,
  ShieldCheck,
  SignOut,
  Sun,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import type { Me } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { useTheme } from "../lib/theme.js";
import { SegmentedControl } from "./SegmentedControl.js";

/** One focusable-element selector shared by the focus-trap and the focus-on-open
 * move, so the two can never disagree on what the menu's first/last focusable is. */
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** First letter of the display name, falling back to the email — a calm avatar
 * fallback when the identity provider gives no `avatarUrl`. Tolerates a null/absent
 * name or email (some providers omit one). */
function initial(me: Me): string {
  const source = me.name?.trim() || me.email?.trim() || "";
  return (source[0] ?? "?").toUpperCase();
}

/** Best display label for the account, never empty. */
function label(me: Me): string {
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
 * mobile bar. */
export function UserMenu({
  me,
  placement = "down",
  expanded = false,
}: {
  me: Me;
  placement?: "down" | "up";
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { choice, setChoice } = useTheme();
  const canSignOut = me.authMode !== "proxy";
  const openUp = placement === "up";

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

  // On open, move focus into the menu (its first focusable control) so keyboard
  // users land inside the popover; the Escape handler above restores focus to the
  // trigger on close.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    (menu?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? menu)?.focus();
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", expanded && "w-full")}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
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
          className={cn(
            "absolute z-40 w-60 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-panel)]",
            // Open up (rail footer) vs. down (mobile bar). The full-width rail
            // trigger left-aligns the menu within the rail; the compact trigger
            // keeps the right edge so the wider menu can't push off-screen.
            openUp ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]",
            expanded ? "left-0" : "right-0",
            openUp ? (expanded ? "origin-bottom-left" : "origin-bottom-right") : "origin-top-right",
          )}
        >
          <div className="flex items-center gap-3 border-border border-b px-3.5 py-3">
            <Avatar me={me} className="size-9 text-sm" />
            <div className="min-w-0">
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
          </div>

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

          {canSignOut && (
            <a
              href="/auth/logout"
              role="menuitem"
              className="flex items-center gap-2.5 border-border border-t px-3.5 py-2.5 text-fg text-sm transition-colors hover:bg-surface-sunken"
            >
              <SignOut size={16} aria-hidden className="text-muted" />
              Sign out
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Avatar({ me, className }: { me: Me; className?: string }) {
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
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-accent-subtle font-semibold text-[0.8125rem] text-accent",
        className,
      )}
    >
      {initial(me)}
    </span>
  );
}
