import { Link } from "@tanstack/react-router";
import { cn } from "../lib/cn.js";
import { PageHeader } from "./Surface.js";

type AdminRoute = "/admin" | "/admin/canvases" | "/admin/users" | "/admin/settings";

const ADMIN_TABS: ReadonlyArray<{ to: AdminRoute; label: string; exact?: boolean }> = [
  { to: "/admin", label: "Overview", exact: true },
  { to: "/admin/canvases", label: "Canvases" },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/settings", label: "Configuration" },
];

export function AdminHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-3">
      <PageHeader title={title} description={description} className="border-b-0 pb-0" />
      <nav
        className="flex flex-wrap items-center gap-1 border-b border-border"
        aria-label="Admin sections"
      >
        {ADMIN_TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={tab.exact ? { exact: true } : undefined}
            activeProps={{ "aria-current": "page" }}
            className={cn(
              "-mb-px border-border border-b-2 px-3 py-2 text-sm font-medium text-muted transition-colors",
              "hover:border-border-strong hover:text-fg",
              "aria-[current=page]:border-accent aria-[current=page]:text-fg",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
