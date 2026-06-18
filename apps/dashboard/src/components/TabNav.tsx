import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { cn } from "../lib/cn.js";

/**
 * One tab in a {@link TabNav}. These are navigation links (not ARIA `tab`s): each
 * one routes and the current one is marked with `aria-current="page"`, the correct
 * pattern for nav-style links.
 */
export interface TabNavItem {
  /** TanStack route path (e.g. `/admin/canvases` or `/canvases/$id/editor`). */
  to: string;
  /** Route params when `to` is parameterised (e.g. `{ id }`). */
  params?: Record<string, string>;
  label: string;
  /**
   * Match the route exactly (TanStack `activeOptions.exact`). Use for an index/parent
   * tab (e.g. Overview) so it isn't also "active" on its children.
   */
  end?: boolean;
}

export interface TabNavProps {
  items: ReadonlyArray<TabNavItem>;
  /** Accessible name for the whole nav (required — this is a `<nav>` landmark). */
  "aria-label": string;
  className?: string;
}

/**
 * The single horizontal tab-bar primitive: a row of TanStack `<Link>`s with a
 * consistent underline + padding, the active one marked via `activeProps`
 * (`aria-current="page"`) so the styling and the a11y can't drift apart.
 *
 * Overflow is handled, not clipped: the row scrolls horizontally with a soft
 * edge-fade mask so an overflowing bar (e.g. the ~7-tab canvas-detail nav on a
 * narrow screen) signals there's more rather than hard-cutting a tab off. The
 * active tab is also scrolled into view on each route change.
 */
export function TabNav({ items, "aria-label": ariaLabel, className }: TabNavProps) {
  const navRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // Keep the current tab visible in the horizontally-scrolling row. On a phone an
  // overflowing bar can leave the active tab half-clipped off an edge; re-scroll it
  // into view whenever the route changes. `nearest` avoids any vertical page jump.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intended trigger — the effect re-scrolls the (newly) active tab into view on each route change, it doesn't read pathname's value.
  useEffect(() => {
    // Optional-chain the method: jsdom (tests) doesn't implement scrollIntoView, and
    // it's a pure progressive enhancement, so a no-op there is correct.
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [pathname]);

  return (
    // The mask gives a soft fade at whichever edge is overflowing, so a scrollable
    // tab bar reads as "there's more" instead of a hard clip. `overflow-x-auto`
    // makes it actually scrollable; the negative bottom margin lands the underline
    // on the container's border.
    <div
      className={cn(
        "overflow-x-auto [-webkit-overflow-scrolling:touch] [mask-image:linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-1.25rem),transparent)]",
        className,
      )}
    >
      <nav ref={navRef} className="flex w-max min-w-full items-center gap-1" aria-label={ariaLabel}>
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            params={item.params}
            activeOptions={item.end ? { exact: true } : undefined}
            activeProps={{ "aria-current": "page" }}
            className={cn(
              "relative -mb-px shrink-0 border-b-2 border-transparent px-3 py-3 text-sm font-medium text-muted transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
              "hover:text-fg",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
              "aria-[current=page]:border-accent aria-[current=page]:text-fg",
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
