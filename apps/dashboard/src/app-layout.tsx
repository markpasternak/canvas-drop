import { BookOpen, List, Monitor, MoonStars, Plus, Sun, X } from "@phosphor-icons/react";
import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "./components/Brand.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { SegmentedControl } from "./components/SegmentedControl.js";
import { ShortcutsHost } from "./components/Shortcuts.js";
import { UserMenu } from "./components/UserMenu.js";
import { cn } from "./lib/cn.js";
import { useMe } from "./lib/queries.js";
import { useTheme } from "./lib/theme.js";

/** Section links shown in the desktop bar and the mobile menu. `exact` keeps
 *  "Canvases" from lighting on canvas detail pages; `adminOnly` is filtered by
 *  the server-resolved me.isAdmin (UX only — the admin API 404s non-admins). */
const SECTION_LINKS: ReadonlyArray<{
  to: "/" | "/admin" | "/gallery";
  label: string;
  exact?: boolean;
  adminOnly?: boolean;
}> = [
  { to: "/", label: "Canvases", exact: true },
  { to: "/gallery", label: "Gallery" },
  // Admin sits last — to the right of the member-facing sections, visible only to
  // admins (and the admin API independently 404s non-admins).
  { to: "/admin", label: "Admin", adminOnly: true },
];

function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  return (
    <SegmentedControl
      aria-label="Theme"
      iconOnly
      value={choice}
      onChange={setChoice}
      items={[
        { value: "system", label: "Use system theme", title: "Theme: System", icon: Monitor },
        { value: "light", label: "Use light theme", title: "Theme: Light", icon: Sun },
        { value: "dark", label: "Use dark theme", title: "Theme: Dark", icon: MoonStars },
      ]}
    />
  );
}

/** The root shell: a slim top bar (wordmark + create + theme) over the routed
 * content. The wordmark is org-agnostic and re-skinnable. */
export function AppLayout() {
  // isAdmin is server-resolved (/api/me). Hiding the link is UX only — the admin
  // API independently 404s non-admins, so this is not a security boundary.
  const me = useMe();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  // The mobile menu is `md:hidden`; if the viewport grows past `md` while it's
  // open, reset the state so it doesn't reappear on a later shrink back to mobile.
  useEffect(() => {
    const mq = window.matchMedia?.("(min-width: 768px)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMenuOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Focus management for the mobile section menu, mirroring the Dialog pattern:
  // move focus into the menu on open, trap Tab within it, close on Escape, and
  // restore focus to the toggle when it closes. Keyboard-only nav can't escape
  // the open menu and never strands focus on a hidden element.
  useEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    // Move focus into the menu (first focusable link) on open.
    menu?.querySelector<HTMLElement>("a[href]")?.focus() ?? menu?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        return;
      }
      if (e.key !== "Tab" || !menu) return;
      const focusables = menu.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
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
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus to the toggle when the menu closes.
      menuTriggerRef.current?.focus?.();
    };
  }, [menuOpen]);
  const links = SECTION_LINKS.filter((l) => !l.adminOnly || me.data?.isAdmin);
  const linkClass =
    "rounded-md px-3 py-1.5 font-medium text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface hover:text-fg aria-[current=page]:bg-surface aria-[current=page]:text-fg aria-[current=page]:shadow-[0_1px_3px_hsl(var(--shadow-color)/0.12)]";
  // One renderer for both navs so a future Link-prop change can't be applied to
  // only one copy. `onSelect` is the sole difference (the mobile menu closes on
  // tap); the desktop bar passes none.
  const renderLink = (l: (typeof SECTION_LINKS)[number], onSelect?: () => void) => (
    <Link
      key={l.to}
      to={l.to}
      activeOptions={l.exact ? { exact: true } : undefined}
      onClick={onSelect}
      className={linkClass}
      activeProps={{ "aria-current": "page" }}
    >
      {l.label}
    </Link>
  );

  return (
    <div className="min-h-dvh bg-canvas">
      {/* Command palette (⌘K) — mounted once app-wide; owns its own open shortcut. */}
      <CommandPalette />
      {/* Keyboard-shortcut cheatsheet (?) — mounted once; owns its "?" shortcut. */}
      <ShortcutsHost />
      <header className="sticky top-0 z-30 border-b border-border/80 bg-surface/90 backdrop-blur-xl supports-[backdrop-filter]:bg-surface/78">
        <div className="mx-auto flex h-16 max-w-[112rem] items-center justify-between gap-4 px-5">
          <div className="flex min-w-0 items-center gap-3 md:gap-5">
            {/* Mobile menu toggle — the section links collapse below `md`, so this
                is the only way to reach Archived / Admin / Gallery on a phone. */}
            <button
              ref={menuTriggerRef}
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-sunken text-muted transition-colors hover:text-fg md:hidden"
            >
              {menuOpen ? (
                <X size={18} weight="bold" aria-hidden />
              ) : (
                <List size={18} weight="bold" aria-hidden />
              )}
            </button>
            <Link
              to="/"
              aria-label="canvas-drop home"
              className="group flex min-w-0 items-center gap-2.5 text-fg"
            >
              <BrandMark className="size-8" />
              <span className="truncate text-[0.9375rem] font-semibold tracking-tight">
                canvas-drop
              </span>
            </Link>
            {/* Primary section nav: the first secondary navigation in the shell.
                "Canvases" matches only the list root (exact) so it isn't lit on
                canvas detail pages; "Archived" lights on /archived. */}
            <nav
              className="hidden items-center gap-1 rounded-lg border border-border bg-surface-sunken p-1 text-[0.8125rem] md:flex"
              aria-label="Sections"
            >
              {links.map((l) => renderLink(l))}
            </nav>
          </div>
          <nav className="flex shrink-0 items-center gap-2" aria-label="Primary actions">
            <Link
              to="/new"
              aria-label="Create canvas"
              title="Create canvas"
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-[0.8125rem] font-semibold text-accent-fg",
                "shadow-[var(--shadow-panel)] transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-accent-hover active:translate-y-px",
              )}
            >
              <Plus size={16} weight="bold" aria-hidden />
              <span>
                Create <span className="hidden sm:inline">canvas</span>
              </span>
            </Link>
            {/* Docs are server-rendered at /docs (outside the SPA), so this is a
                plain anchor, NOT a TanStack <Link>. Icon-only on the narrowest bar. */}
            <a
              href="/docs"
              aria-label="Documentation"
              title="Documentation"
              className="hidden h-9 items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 text-[0.8125rem] font-medium text-muted transition-colors hover:text-fg sm:inline-flex"
            >
              <BookOpen size={16} weight="regular" aria-hidden />
              <span className="hidden lg:inline">Docs</span>
            </a>
            <ThemeSwitch />
            {me.data && <UserMenu me={me.data} />}
          </nav>
        </div>

        {/* Mobile section menu (below `md`). A backdrop closes on outside tap; each
            link closes on select. Hidden from the a11y tree + tab order when shut. */}
        {menuOpen && (
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              data-testid="menu-backdrop"
              className="fixed inset-0 top-16 z-20 cursor-default bg-transparent md:hidden"
              onClick={() => setMenuOpen(false)}
            />
            <nav
              ref={menuRef}
              className="relative z-30 flex flex-col gap-1 border-border border-t bg-surface px-5 py-3 text-sm md:hidden"
              aria-label="Sections"
            >
              {links.map((l) => renderLink(l, () => setMenuOpen(false)))}
              <a href="/docs" onClick={() => setMenuOpen(false)} className={linkClass}>
                Docs
              </a>
            </nav>
          </>
        )}
      </header>
      <main className="mx-auto max-w-[112rem] px-5 py-6">
        <Outlet />
      </main>
    </div>
  );
}
