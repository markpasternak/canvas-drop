import { useNavigate, useSearch } from "@tanstack/react-router";
import { AdminActivityList, activityLabel } from "../components/AdminActivityList.js";
import { AdminHeader } from "../components/AdminHeader.js";
import { Button } from "../components/Button.js";
import { Field } from "../components/Field.js";
import { FilterSelect } from "../components/Filters.js";
import { ReadError } from "../components/ReadError.js";
import { SearchInput } from "../components/SearchInput.js";
import { useAdminActivity } from "../lib/queries.js";
import { useDebouncedUrlSearch } from "../lib/use-debounced-url-search.js";

export default function AdminActivity() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const value = (key: string) => (typeof search[key] === "string" ? (search[key] as string) : "");
  const q = value("q");
  const filtering = ["q", "actor", "canvasId", "action", "from", "to"].some((key) =>
    Boolean(value(key)),
  );
  const invalidRange = Boolean(value("from") && value("to") && value("from") > value("to"));
  const page = Math.max(
    1,
    Math.min(40_001, Number.isSafeInteger(Number(search.page)) ? Number(search.page) : 1),
  );
  const dateStart = (input: string) => {
    const result = input ? new Date(`${input}T00:00:00`).getTime() : NaN;
    return Number.isFinite(result) ? result : undefined;
  };
  const untilStart = dateStart(value("to"));
  const end = untilStart === undefined ? undefined : new Date(untilStart);
  if (end) end.setDate(end.getDate() + 1);
  const activity = useAdminActivity({
    q: q || undefined,
    actor: value("actor") || undefined,
    canvasId: value("canvasId") || undefined,
    action: value("action") || undefined,
    since: dateStart(value("from")),
    until: end?.getTime(),
    limit: 25,
    offset: (page - 1) * 25,
  });
  const [text, setText] = useDebouncedUrlSearch(q || undefined, "/admin/activity");
  const set = (key: string, next: string | number | undefined) =>
    navigate({
      to: "/admin/activity",
      search: (prev) => ({
        ...prev,
        [key]: next || undefined,
        ...(key === "page" ? {} : { page: 1 }),
      }),
    });
  return (
    <div className="space-y-6">
      <AdminHeader
        title="Activity"
        description="Search canvas and administrative changes, including who acted and the recorded reason."
      />
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          aria-label="Search administrative activity"
          placeholder="Search actor, canvas, or action"
          value={text}
          onChange={setText}
        />
        <FilterSelect
          label="Activity action"
          value={value("action") || "all"}
          options={[
            { value: "all", label: "All actions" },
            ...(activity.data?.actions ?? []).map((action) => ({
              value: action,
              label: activityLabel(action),
            })),
          ]}
          onValueChange={(next) => set("action", next === "all" ? undefined : next)}
        />
        <fieldset className="flex min-w-0 flex-wrap gap-3">
          <legend className="sr-only">Date range</legend>
          <Field
            label="From date"
            type="date"
            value={value("from")}
            aria-invalid={invalidRange}
            aria-describedby={invalidRange ? "date-range-error" : undefined}
            onChange={(event) => set("from", event.target.value)}
          />
          <Field
            label="Through date"
            type="date"
            value={value("to")}
            aria-invalid={invalidRange}
            aria-describedby={invalidRange ? "date-range-error" : undefined}
            onChange={(event) => set("to", event.target.value)}
          />
        </fieldset>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setText("");
            navigate({ to: "/admin/activity", search: {} });
          }}
        >
          Clear filters
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => activity.refetch()}
          loading={activity.isFetching}
        >
          Refresh
        </Button>
      </div>
      <details open={Boolean(value("actor") || value("canvasId"))} className="space-y-3">
        <summary className="cursor-pointer text-sm text-accent">Exact identifiers</summary>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Actor email or ID"
            value={value("actor")}
            onChange={(event) => set("actor", event.target.value)}
          />
          <Field
            label="Canvas ID"
            value={value("canvasId")}
            onChange={(event) => set("canvasId", event.target.value)}
          />
        </div>
        {value("canvasId") && (
          <p className="break-words text-sm text-muted">
            Activity for {value("canvasTitle") || value("canvasId")}
          </p>
        )}
      </details>
      {invalidRange && (
        <p id="date-range-error" role="alert" className="text-sm text-danger">
          Through date must be on or after From date.
        </p>
      )}
      <p className="text-xs text-subtle">
        Dates use your local time zone. Results cover retained administrative records; older events
        may have been removed by retention policy.
      </p>
      {activity.isLoading && <p role="status">Loading activity…</p>}
      {activity.isError && !invalidRange && (
        <ReadError
          title="Could not load activity"
          onRetry={() => void activity.refetch()}
          retrying={activity.isFetching}
        />
      )}
      {activity.data && !activity.isError && !invalidRange && (
        <>
          <AdminActivityList
            events={activity.data.events}
            emptyMessage={
              filtering
                ? "No changes match these filters. Clear filters or choose another date range."
                : "No administrative changes have been recorded in the retained history yet."
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted">
              {activity.data.total} changes · Page {page}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page === 1 || activity.isPlaceholderData}
                onClick={() => set("page", page - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page * 25 >= activity.data.total || activity.isPlaceholderData}
                onClick={() => set("page", page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
