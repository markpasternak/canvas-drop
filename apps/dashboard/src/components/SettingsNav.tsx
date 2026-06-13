import { cn } from "../lib/cn.js";

/** Floating in-page table of contents for the (long) settings page. Sticks
 *  beside the content on wide screens; hidden on narrow ones where the page is
 *  short enough to scroll. Mirrors the detail-tab idiom (accent active border). */
export function SettingsNav({
  sections,
  active,
  onSelect,
}: {
  sections: readonly { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="hidden lg:block lg:sticky lg:top-20 lg:self-start"
    >
      <ul className="border-l border-border">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              onClick={() => onSelect(s.id)}
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
