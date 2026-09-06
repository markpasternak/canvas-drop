import { Link } from "@tanstack/react-router";
import type { AdminActivityEvent } from "../lib/api.js";

export const activityLabel = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

export function AdminActivityList({
  events,
  showTarget = true,
}: {
  events: AdminActivityEvent[];
  showTarget?: boolean;
}) {
  if (!events.length)
    return <p className="text-sm text-muted">No administrative changes in this view.</p>;
  return (
    <ol className="divide-y divide-border rounded-lg border border-border bg-surface">
      {events.map((event) => (
        <li key={event.id} className="space-y-2 p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-fg">{activityLabel(event.action)}</span>
            <time
              dateTime={new Date(event.createdAt).toISOString()}
              className="text-xs text-subtle"
            >
              {new Date(event.createdAt).toLocaleString()}
            </time>
          </div>
          <p className="break-words text-muted">
            {event.actorEmail ?? event.actorName ?? event.actorId ?? "System"}
            {showTarget && event.targetId && (
              <>
                {" "}
                ·{" "}
                {event.targetType === "canvas" ? (
                  <Link
                    className="text-accent hover:underline"
                    to="/admin/canvases"
                    search={{ inspect: event.targetId }}
                  >
                    {event.canvasTitle || event.canvasSlug || event.targetId}
                  </Link>
                ) : (
                  event.targetId
                )}
              </>
            )}
          </p>
          {Object.keys(event.details).length > 0 && (
            <dl className="grid gap-1 text-xs text-muted">
              {Object.entries(event.details).map(([key, value]) => (
                <div key={key} className="flex flex-wrap gap-x-2">
                  <dt className="font-medium">{activityLabel(key)}:</dt>
                  <dd className="break-all">
                    {Array.isArray(value)
                      ? value.join(", ")
                      : typeof value === "boolean"
                        ? value
                          ? "Yes"
                          : "No"
                        : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ol>
  );
}
