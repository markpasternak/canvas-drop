import { Monitor, MoonStars, Plus, Sun } from "@phosphor-icons/react";
import { Link, Outlet } from "@tanstack/react-router";
import { BrandMark } from "./components/Brand.js";
import { cn } from "./lib/cn.js";
import { useMe } from "./lib/queries.js";
import { useTheme } from "./lib/theme.js";

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
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-surface/90 backdrop-blur-xl supports-[backdrop-filter]:bg-surface/78">
        <div className="mx-auto flex h-16 max-w-[112rem] items-center justify-between gap-4 px-5">
          <div className="flex min-w-0 items-center gap-5">
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
              <Link
                to="/"
                activeOptions={{ exact: true }}
                className="rounded-md px-3 py-1.5 font-medium text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface hover:text-fg aria-[current=page]:bg-surface aria-[current=page]:text-fg aria-[current=page]:shadow-[0_1px_3px_hsl(var(--shadow-color)/0.12)]"
                activeProps={{ "aria-current": "page" }}
              >
                Canvases
              </Link>
              <Link
                to="/archived"
                className="rounded-md px-3 py-1.5 font-medium text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface hover:text-fg aria-[current=page]:bg-surface aria-[current=page]:text-fg aria-[current=page]:shadow-[0_1px_3px_hsl(var(--shadow-color)/0.12)]"
                activeProps={{ "aria-current": "page" }}
              >
                Archived
              </Link>
              {me.data?.isAdmin && (
                <Link
                  to="/admin"
                  className="rounded-md px-3 py-1.5 font-medium text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface hover:text-fg aria-[current=page]:bg-surface aria-[current=page]:text-fg aria-[current=page]:shadow-[0_1px_3px_hsl(var(--shadow-color)/0.12)]"
                  activeProps={{ "aria-current": "page" }}
                >
                  Admin
                </Link>
              )}
              <Link
                to="/gallery"
                className="rounded-md px-3 py-1.5 font-medium text-muted transition-all duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface hover:text-fg aria-[current=page]:bg-surface aria-[current=page]:text-fg aria-[current=page]:shadow-[0_1px_3px_hsl(var(--shadow-color)/0.12)]"
                activeProps={{ "aria-current": "page" }}
              >
                Gallery
              </Link>
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
      </header>
      <main className="mx-auto max-w-[112rem] px-5 py-6">
        <Outlet />
      </main>
    </div>
  );
}
