import type { ReactNode } from "react";
import { PageHeader } from "./Surface.js";
import { TabNav, type TabNavItem } from "./TabNav.js";

const ADMIN_TABS: ReadonlyArray<TabNavItem> = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/canvases", label: "Canvases" },
  { to: "/admin/users", label: "People" },
  { to: "/admin/settings", label: "Configuration" },
];

export function AdminHeader({
  title,
  description,
  eyebrow,
}: {
  title: string;
  description: string;
  /** Optional scope eyebrow above the title (e.g. "Admin · All owners") so a
   *  governance surface that reuses owner-list primitives still reads unmistakably
   *  as the admin, cross-owner view. */
  eyebrow?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <PageHeader
        title={title}
        description={description}
        eyebrow={eyebrow}
        className="border-b-0 pb-0"
      />
      <TabNav items={ADMIN_TABS} aria-label="Admin sections" className="border-b border-border" />
    </div>
  );
}
