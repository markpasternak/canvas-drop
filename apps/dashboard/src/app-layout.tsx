import { List, Monitor, MoonStars, Plus, Sun, X } from "@phosphor-icons/react";
import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { BrandMark } from "./components/Brand.js";
import { cn } from "./lib/cn.js";
import { useMe } from "./lib/queries.js";
import { useTheme } from "./lib/theme.js";

/** Section links shown in the desktop bar and the mobile menu. `exact` keeps
 *  "Canvases" from lighting on canvas detail pages; `adminOnly` is filtered by
 *  the server-resolved me.isAdmin (UX only — the admin API 404s non-admins). */
const SECTION_LINKS: ReadonlyArray<{
  to: "/" | "/archived" | "/admin" | "/gallery";
  label: string;
  exact?: boolean;
  adminOnly?: boolean;
}> = [
  { to: "/", label: "Canvases", exact: true },
  { to: "/archived", label: "Archived" },
  { to: "/admin", label: "Admin", adminOnly: true },
  { to: "/gallery", label: "Gallery" },
];

function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  const options = [
    { id: "system", label: "System", icon: Monitor },
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: MoonStars },
  ] as const;

  return (
    <fieldset
      aria-label="Theme"
      className="m-0 grid grid-cols-3 rounded-lg border border-border bg-surface-sunken p-0.5"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = choice === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => setChoice(option.id)}
            aria-pressed={active}
            aria-label={`Use ${option.label.toLowerCase()} theme`}
            title={`Theme: ${option.label}`}
            className={cn(
              "grid size-8 place-items-center rounded-md text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:text-fg active:translate-y-px",
              active && "bg-surface text-fg shadow-[0_1px_3px_hsl(var(--shadow-color)/0.14)]",
            )}
          >
            <Icon size={16} weight={active ? "fill" : "regular"} aria-hidden />
          </button>
        );
      })}
    </fieldset>
  );
}

/** The root shell: a slim top bar (wordmark + create + theme) over the routed
 * content. The wordmark is org-agnostic and re-skinnable. */
export function AppLayout() {
  // isAdmin is server-resolved (/api/me). Hiding the link is UX only — the admin
  // API independently 404s non-admins, so this is not a security boundary.
  const me = useMe();
  const [menuOpen, setMenuOpen] = useState(false);
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
      <header className="sticky top-0 z-30 border-b border-border/80 bg-surface/90 backdrop-blur-xl supports-[backdrop-filter]:bg-surface/78">
        <div className="mx-auto flex h-16 max-w-[112rem] items-center justify-between gap-4 px-5">
          <div className="flex min-w-0 items-center gap-3 md:gap-5">
            {/* Mobile menu toggle — the section links collapse below `md`, so this
                is the only way to reach Archived / Admin / Gallery on a phone. */}
            <button
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
              aria-label="Canvasdrop home"
              className="group flex min-w-0 items-center gap-2.5 text-fg"
            >
              <BrandMark className="size-8" />
              <span className="truncate text-[0.9375rem] font-semibold tracking-tight">
                Canvasdrop
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
            <ThemeSwitch />
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
              className="relative z-30 flex flex-col gap-1 border-border border-t bg-surface px-5 py-3 text-sm md:hidden"
              aria-label="Sections"
            >
              {links.map((l) => renderLink(l, () => setMenuOpen(false)))}
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
