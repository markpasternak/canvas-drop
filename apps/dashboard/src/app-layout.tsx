import { Link, Outlet } from "@tanstack/react-router";
import { cn } from "./lib/cn.js";
import { useTheme } from "./lib/theme.js";

function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  const order = ["system", "light", "dark"] as const;
  const next = order[(order.indexOf(choice) + 1) % order.length] ?? "system";
  const label = { system: "Auto", light: "Light", dark: "Dark" }[choice];
  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      className="rounded-md px-2.5 py-1 text-xs font-medium text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-accent-subtle hover:text-fg"
      title={`Theme: ${label} (click to change)`}
    >
      {label}
    </button>
  );
}

/** The root shell: a slim top bar (wordmark + create + theme) over the routed
 * content. The wordmark is org-agnostic and re-skinnable. */
export function AppLayout() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-border bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5">
          <div className="flex items-center gap-5">
            <Link
              to="/"
              className="flex items-center gap-2 text-sm font-semibold tracking-tight text-fg"
            >
              <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-fg">
                <span className="size-2 rounded-[3px] bg-accent-fg" />
              </span>
              canvas-drop
            </Link>
            {/* Primary section nav — the first secondary navigation in the shell.
                "Canvases" matches only the list root (exact) so it isn't lit on
                canvas detail pages; "Archived" lights on /archived. */}
            <nav className="flex items-center gap-1 text-[0.8125rem]" aria-label="Sections">
              <Link
                to="/"
                activeOptions={{ exact: true }}
                className="rounded-md px-2.5 py-1 font-medium text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:text-fg aria-[current=page]:text-fg"
                activeProps={{ "aria-current": "page" }}
              >
                Canvases
              </Link>
              <Link
                to="/archived"
                className="rounded-md px-2.5 py-1 font-medium text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:text-fg aria-[current=page]:text-fg"
                activeProps={{ "aria-current": "page" }}
              >
                Archived
              </Link>
            </nav>
          </div>
          <nav className="flex items-center gap-1">
            <Link
              to="/new"
              className={cn(
                "rounded-md bg-accent px-3 py-1.5 text-[0.8125rem] font-medium text-accent-fg",
                "transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-accent-hover",
              )}
            >
              Create canvas
            </Link>
            <ThemeSwitch />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8">
        <Outlet />
      </main>
    </div>
  );
}
