import { cn } from "../lib/cn.js";

/** Floating in-page table of contents for the (long) settings page. Sticks
 *  beside the content on wide screens; hidden on narrow ones where the page is
 *  short enough to scroll. Mirrors the detail-tab idiom (accent active border). */
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
    <nav aria-label={ariaLabel} className="hidden lg:block lg:sticky lg:top-20 lg:self-start">
      <ul className="border-l border-border">
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
                "-ml-px block border-l-2 py-1.5 pl-3 text-sm transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
                active === s.id
                  ? "border-accent font-medium text-fg"
                  : "border-transparent text-muted hover:border-border-strong hover:text-fg",
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
