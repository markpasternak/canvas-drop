import { cn } from "../lib/cn.js";

/** In-page navigation: a compact scrollable row on mobile, sticky list on desktop. */
export function SettingsNav({
  sections,
  active,
  onSelect,
  ariaLabel = "Settings sections",
}: {
  sections: readonly { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
  ariaLabel?: string;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className="mb-6 overflow-x-auto lg:sticky lg:top-20 lg:mb-0 lg:self-start"
    >
      <ul className="flex gap-1 lg:flex-col">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              onClick={(e) => {
                // Scroll the section in ourselves. A bare `#hash` anchor is intercepted by the
                // router (which prevents the fragment scroll and resets to top), so the native
                // behavior is unreliable inside the SPA — drive it explicitly instead.
                e.preventDefault();
                onSelect(s.id);
                // `instant`, not `smooth`: a smooth scrollIntoView is a no-op under some engines
                // (and reduced-motion), so a guaranteed jump beats a sometimes-silent animation.
                document
                  .getElementById(s.id)
                  ?.scrollIntoView({ behavior: "instant", block: "start" });
              }}
              aria-current={active === s.id ? "true" : undefined}
              className={cn(
                "block whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
                active === s.id
                  ? "bg-surface-sunken font-medium text-fg"
                  : "text-muted hover:bg-surface-raised hover:text-fg",
              )}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
