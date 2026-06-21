import type { Icon } from "@phosphor-icons/react";
import {
  ArrowSquareOut,
  BookOpen,
  Compass,
  List,
  Plus,
  ShieldCheck,
  SidebarSimple,
  SquaresFour,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "./components/Brand.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ShortcutsHost } from "./components/Shortcuts.js";
import { UserMenu } from "./components/UserMenu.js";
import { cn } from "./lib/cn.js";
import { useNavCollapsed } from "./lib/nav-collapsed.js";
import { useMe } from "./lib/queries.js";

/** Section links shown in the left rail and the mobile menu. `exact` keeps
 *  "Canvases" from lighting on canvas detail pages; `adminOnly` is filtered by
 *  the server-resolved me.isAdmin (UX only — the admin API 404s non-admins).
 *  Icons match the preview's left-rail nav (icon + label per item). These are the
 *  REAL routes — no fake Templates/Trash entries the preview used as filler. */
const SECTION_LINKS: ReadonlyArray<{
  to: "/" | "/admin" | "/gallery" | "/teams";
  label: string;
  icon: Icon;
  exact?: boolean;
  adminOnly?: boolean;
}> = [
  { to: "/", label: "Canvases", icon: SquaresFour, exact: true },
  { to: "/gallery", label: "Gallery", icon: Compass },
  // Teams (plan 003 U6) — any signed-in user can have personal teams (friends & family),
  // so this is no longer org-gated.
  { to: "/teams", label: "Teams", icon: UsersThree },
  // Admin sits last — below the member-facing sections, visible only to admins
  // (and the admin API independently 404s non-admins).
  { to: "/admin", label: "Admin", icon: ShieldCheck, adminOnly: true },
];

/** The teal logo tile from the preview's `.brand .mark`: a rounded accent-filled
 *  square with the white brand mark, paired with the "canvas-drop" wordmark. A
 *  link home; org-agnostic and re-skinnable. */
function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link
      to="/"
      aria-label="canvas-drop home"
      title={collapsed ? "canvas-drop" : undefined}
      className={cn(
        "group flex min-w-0 items-center gap-2.5 text-fg",
        collapsed && "justify-center",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-[0.625rem] bg-accent shadow-[var(--shadow-ctrl,0_1px_2px_hsl(var(--shadow-color)/0.12))] [--logo-frame:var(--accent-fg)] [--logo-drop:var(--accent-fg)]">
        <BrandMark className="size-5" />
      </span>
      {!collapsed && (
        <span className="truncate text-[0.9375rem] font-semibold tracking-tight">canvas-drop</span>
      )}
    </Link>
  );
}

/** The prominent "Create canvas" button — the dominant create action, pinned near
 *  the brand in the rail (and in the mobile top bar). */
function CreateCanvasButton({
  onSelect,
  className,
  compact,
  collapsed,
}: {
  onSelect?: () => void;
  className?: string;
  compact?: boolean;
  /** Rail-collapsed: render icon-only, keeping the accessible name via aria-label/title. */
  collapsed?: boolean;
}) {
  return (
    <Link
      to="/new"
      aria-label="Create canvas"
      title="Create canvas"
      onClick={onSelect}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent text-[0.8125rem] font-semibold text-accent-fg",
        collapsed ? "px-0" : "px-3.5",
        "shadow-[var(--shadow-panel)] transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-accent-hover active:translate-y-px",
        className,
      )}
    >
      <Plus size={16} weight="bold" aria-hidden />
      {!collapsed && (
        <span>Create{compact ? <span className="hidden sm:inline"> canvas</span> : " canvas"}</span>
      )}
    </Link>
  );
}

/** Docs anchor. Docs are server-rendered at /docs (outside the SPA), so this is a
 *  plain anchor, NOT a TanStack <Link>. It's a separate surface, so it opens in a
 *  new tab — with a subtle external-link affordance when expanded. `block` renders
 *  it as a full-width row (the rail's expanded footer) rather than a chip. */
function DocsLink({
  onSelect,
  className,
  collapsed,
  block,
}: {
  onSelect?: () => void;
  className?: string;
  collapsed?: boolean;
  block?: boolean;
}) {
  return (
    <a
      href="/docs"
      target="_blank"
      rel="noreferrer"
      aria-label="Documentation"
      title="Documentation (opens in a new tab)"
      onClick={onSelect}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-sunken text-[0.8125rem] font-medium text-muted transition-colors hover:text-fg",
        collapsed ? "w-9 justify-center px-0" : "px-3",
        block && !collapsed && "w-full",
        className,
      )}
    >
      <BookOpen size={16} weight="regular" aria-hidden className="shrink-0" />
      {!collapsed && (
        <>
          <span>Docs</span>
          <ArrowSquareOut size={13} weight="bold" aria-hidden className="ml-auto text-subtle" />
        </>
      )}
    </a>
  );
}

/** Map a pathname to the human page name used in document.title. Keep it coarse —
 *  enough for a screen-reader user to know which page they landed on after an SPA
 *  navigation (TanStack Router manages neither title nor focus on route change). */
function pageNameForPath(pathname: string): string {
  if (pathname === "/") return "Canvases";
  if (pathname === "/gallery") return "Gallery";
  if (pathname === "/teams") return "Teams";
  if (pathname === "/new") return "Create canvas";
  if (pathname === "/onboarding") return "Get started";
  if (pathname === "/admin/canvases") return "Admin · Canvases";
  if (pathname === "/admin/users") return "Admin · Users";
  if (pathname === "/admin/settings") return "Admin · Settings";
  if (pathname === "/admin") return "Admin";
  if (pathname.startsWith("/canvases/")) {
    if (pathname.endsWith("/editor")) return "Editor";
    if (pathname.endsWith("/share")) return "Share";
    if (pathname.endsWith("/versions")) return "Versions";
    if (pathname.endsWith("/settings")) return "Settings";
    if (pathname.endsWith("/capabilities")) return "Capabilities";
    if (pathname.endsWith("/usage")) return "Usage";
    return "Canvas";
  }
  return "canvas-drop";
}

/** The root shell: a fixed left navigation rail (brand · create · nav · account)
 * at `lg+`, collapsing to a top bar + hamburger below `lg`. The routed content
 * renders to the right of the rail and keeps its own behavior — critically the
 * canvases route's right detail rail, so at `xl` it reads: left nav · library ·
 * detail. The wordmark is org-agnostic and re-skinnable. */
export function AppLayout() {
  // isAdmin is server-resolved (/api/me). Hiding the link is UX only — the admin
  // API independently 404s non-admins, so this is not a security boundary.
  const me = useMe();
  // lg+ rail collapse state, persisted in localStorage (default = expanded).
  const { collapsed, toggle: toggleCollapsed } = useNavCollapsed();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  // SPA navigations are silent for screen readers unless we manage title + focus
  // ourselves (TanStack Router does neither). On each pathname change, set
  // document.title and move focus to the #main-content landmark so AT announces
  // the new page. Keyed on pathname only — not on every router state tick.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    document.title = `${pageNameForPath(pathname)} — canvas-drop`;
    document.getElementById("main-content")?.focus();
  }, [pathname]);
  // The mobile menu is `lg:hidden`; if the viewport grows past `lg` (the fixed
  // rail takes over) while it's open, reset the state so it doesn't reappear on a
  // later shrink back to mobile.
  useEffect(() => {
    const mq = window.matchMedia?.("(min-width: 1024px)");
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
  // Vertical nav item: icon + label, active item lifted to accent-subtle/accent
  // (matches the preview's `.nav a.active`).
  const navLinkClass =
    "flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.875rem] font-medium text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface-hover hover:text-fg aria-[current=page]:bg-accent-subtle aria-[current=page]:text-accent";
  // One renderer for both navs so a future Link-prop change can't be applied to
  // only one copy. `onSelect` is the mobile-menu close-on-tap; `isCollapsed`
  // (rail only) drops the visible label to an icon-only item that keeps its
  // accessible name via aria-label/title.
  const renderLink = (
    l: (typeof SECTION_LINKS)[number],
    onSelect?: () => void,
    isCollapsed?: boolean,
  ) => {
    const Ic = l.icon;
    return (
      <Link
        key={l.to}
        to={l.to}
        activeOptions={l.exact ? { exact: true } : undefined}
        onClick={onSelect}
        aria-label={isCollapsed ? l.label : undefined}
        title={isCollapsed ? l.label : undefined}
        className={cn(navLinkClass, isCollapsed && "justify-center px-0")}
        activeProps={{ "aria-current": "page" }}
      >
        <Ic size={17} weight="regular" aria-hidden className="shrink-0" />
        {!isCollapsed && <span className="truncate">{l.label}</span>}
      </Link>
    );
  };

  return (
    <div
      className={cn(
        "min-h-dvh bg-canvas lg:grid",
        // The rail column width follows the collapse state so the content area
        // reflows. The width transition is reduced-motion-safe — base.css zeroes
        // transition-duration under prefers-reduced-motion.
        "transition-[grid-template-columns] duration-200 [transition-timing-function:var(--ease-out)]",
        collapsed ? "lg:grid-cols-[4rem_minmax(0,1fr)]" : "lg:grid-cols-[15rem_minmax(0,1fr)]",
      )}
    >
      {/* Skip-to-content: the first focusable element in the DOM, so a keyboard or
          screen-reader user can jump straight to the routed content without tabbing
          through the whole rail. Visually hidden until focused (Tailwind's
          sr-only / focus:not-sr-only), then it pops to the top-left as a real chip.
          Targets the #main-content landmark below. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:inline-flex focus:h-9 focus:items-center focus:rounded-lg focus:border focus:border-border focus:bg-surface-raised focus:px-3.5 focus:font-medium focus:text-fg focus:text-sm focus:shadow-[var(--shadow-popover)]"
      >
        Skip to content
      </a>
      {/* Command palette (⌘K) — mounted once app-wide; owns its own open shortcut. */}
      <CommandPalette />
      {/* Keyboard-shortcut cheatsheet (?) — mounted once; owns its "?" shortcut. */}
      <ShortcutsHost />

      {/* ── Left navigation rail (lg+): fixed ~240px expanded, ~4rem collapsed.
          Brand tile + collapse toggle + create at the top, the vertical section
          nav in the middle, Docs + the account row pinned at the bottom. The theme
          switch lives inside the account menu.
          When collapsed every item is icon-only but keeps its accessible name. ── */}
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh flex-col gap-5 border-border/80 border-r bg-surface py-4 lg:flex",
          collapsed ? "px-2" : "px-3.5",
        )}
        aria-label="Sidebar"
      >
        <div
          className={cn("flex items-center gap-1", collapsed ? "flex-col" : "justify-between pl-1")}
        >
          <Brand collapsed={collapsed} />
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <SidebarSimple size={18} weight="regular" aria-hidden />
          </button>
        </div>
        <CreateCanvasButton collapsed={collapsed} />
        {/* Primary section nav: the first "Sections" landmark in the shell. */}
        <nav className="flex flex-col gap-0.5" aria-label="Sections">
          {links.map((l) => renderLink(l, undefined, collapsed))}
        </nav>
        {/* Footer, pinned to the bottom of the rail: a Docs row above a full-width
            account row. The theme switch now lives INSIDE the account menu, so the
            footer stays lean. When collapsed every control is icon-only and
            centered. The account menu opens UPWARD here — its trigger sits at the
            bottom of the viewport, so a downward popover would fall below the fold. */}
        <div
          className={cn(
            "mt-auto flex flex-col border-border/70 border-t pt-3",
            collapsed ? "items-center gap-2" : "gap-2",
          )}
        >
          <DocsLink collapsed={collapsed} block />
          {me.data && (
            <div className={cn(!collapsed && "mt-1 border-border/70 border-t pt-2")}>
              <UserMenu me={me.data} placement="up" expanded={!collapsed} />
            </div>
          )}
        </div>
      </aside>

      {/* ── Right column: a slim top bar below `lg` (brand + hamburger + create +
          account), then the routed content. The content keeps `--content-max`
          and the canvases route's own right detail rail. ──────────────────── */}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 border-b border-border/80 bg-surface/90 backdrop-blur-xl supports-[backdrop-filter]:bg-surface/78 lg:hidden">
          <div className="flex h-16 items-center justify-between gap-3 px-5">
            <div className="flex min-w-0 items-center gap-3">
              {/* Mobile menu toggle — the section nav lives in the rail, hidden
                  below `lg`, so this hamburger is the only way to reach the
                  sections on a phone. */}
              <button
                ref={menuTriggerRef}
                type="button"
                aria-label={menuOpen ? "Close menu" : "Open menu"}
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-sunken text-muted transition-colors hover:text-fg"
              >
                {menuOpen ? (
                  <X size={18} weight="bold" aria-hidden />
                ) : (
                  <List size={18} weight="bold" aria-hidden />
                )}
              </button>
              <Brand />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <CreateCanvasButton compact className="px-3" />
              {me.data && <UserMenu me={me.data} />}
            </div>
          </div>

          {/* Mobile section menu (below `lg`). A backdrop closes on outside tap;
              each link closes on select. Hidden from the a11y tree + tab order
              when shut. Reuses the focus-trap above. */}
          {menuOpen && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                data-testid="menu-backdrop"
                className="fixed inset-0 top-16 z-20 cursor-default bg-transparent"
                onClick={() => setMenuOpen(false)}
              />
              <nav
                ref={menuRef}
                className="relative z-30 flex flex-col gap-0.5 border-border border-t bg-surface px-5 py-3"
                aria-label="Sections"
              >
                {links.map((l) => renderLink(l, () => setMenuOpen(false)))}
                {/* Theme lives in the account menu (reachable from the mobile top
                    bar), so the mobile menu footer carries only the Docs link — no
                    duplicate theme control. */}
                <div className="mt-2 flex items-center justify-between gap-2 border-border/70 border-t pt-3">
                  <DocsLink onSelect={() => setMenuOpen(false)} />
                </div>
              </nav>
            </>
          )}
        </header>

        {/* The routed-content landmark + skip-link target. tabIndex={-1} makes it a
            programmatic focus target so activating "Skip to content" moves focus here
            (not just the scroll position), which is what AT/keyboard users expect. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[var(--content-max)] px-5 py-6 outline-none"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
