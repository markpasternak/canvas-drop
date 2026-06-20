import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { ActionRow } from "./Surface.js";

/** The flat-band rhythm shared by every stacked section: first one flush, the rest
 *  separated by a top hairline + vertical space. Exported so titleless bands (e.g. the
 *  Overview fact grids) read identically without re-hardcoding the rhythm. */
export const flatBandClass = "border-t border-border pt-6 first:border-t-0 first:pt-0";

/** A titled, flat section grouping related controls. Renders as a hairline-divided
 *  band (serif heading + content) — not a boxed card — so stacked sections read as
 *  editorial bands (DESIGN §Typography/§"Patterns to avoid"). `tone="danger"` colors
 *  the heading `text-danger` (no red box); the destructive control carries the tone. */
export function Section({
  id,
  title,
  description,
  tone = "default",
  children,
}: {
  id: string;
  title: string;
  description?: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      // Flat band rhythm (shared via flatBandClass); `scroll-mt-20` clears the sticky
      // top bar when section-nav jumps here.
      className={cn("scroll-mt-20", flatBandClass)}
    >
      <div className="mb-5 space-y-1">
        <h2
          className={cn(
            "font-display text-h2 leading-tight",
            tone === "danger" ? "text-danger" : "text-fg",
          )}
        >
          {title}
        </h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** A single setting laid out as label/help on the left, control(s) on the
 *  right — generalizing the Toggle row idiom so actions read consistently. */
export function Row({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ActionRow title={title} description={description}>
      {children}
    </ActionRow>
  );
}

/** A hairline divider between rows inside a section. */
export function RowDivider() {
  return <div className="border-t border-border" />;
}
