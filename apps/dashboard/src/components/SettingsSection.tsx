import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { ActionRow, Panel } from "./Surface.js";

/** A titled card grouping related controls. `tone="danger"` tints it for
 *  destructive actions (red border + heading), matching the danger token. */
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
    <Panel
      id={id}
      // Clear the sticky top bar (h-14) when jumped to via the section nav.
      className={cn("scroll-mt-20", tone === "danger" ? "border-danger/40" : "border-border")}
    >
      <div className="mb-5 space-y-1">
        <h2 className={cn("text-sm font-semibold", tone === "danger" ? "text-danger" : "text-fg")}>
          {title}
        </h2>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </Panel>
  );
}

/** A single setting laid out as label/help on the left, control(s) on the
 *  right — generalizing the Toggle row idiom so actions read consistently. */
export function Row({
  title,
  description,
  children,
}: {
  title: string;
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
