import { PageHeader } from "./Surface.js";
import { TabNav, type TabNavItem } from "./TabNav.js";

const ADMIN_TABS: ReadonlyArray<TabNavItem> = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/canvases", label: "Canvases" },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/settings", label: "Configuration" },
];

export function AdminHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-3">
      <PageHeader title={title} description={description} className="border-b-0 pb-0" />
      <TabNav items={ADMIN_TABS} aria-label="Admin sections" className="border-b border-border" />
    </div>
  );
}
