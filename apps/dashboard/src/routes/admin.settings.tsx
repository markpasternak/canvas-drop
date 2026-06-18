import { useState } from "react";
import { AdminHeader } from "../components/AdminHeader.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip } from "../components/Filters.js";
import { SearchInput } from "../components/SearchInput.js";
import { Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { type AdminConfigField, ApiError } from "../lib/api.js";
import { useAdminSetConfig } from "../lib/mutations.js";
import { useAdminConfig } from "../lib/queries.js";

/** Source badge: where a setting's effective value comes from. */
function SourceBadge({ source }: { source: AdminConfigField["source"] }) {
  const tone = source === "database" ? "success" : source === "environment" ? "neutral" : "warning";
  const label =
    source === "database" ? "Database" : source === "environment" ? "Environment" : "Default";
  return <Badge tone={tone}>{label}</Badge>;
}

/** The display string for a setting's current value (secret-aware, never raw). */
function valueLabel(f: AdminConfigField): string {
  if (f.secret) {
    if (!f.set) return "Not set";
    return f.last4 ? `Configured · …${f.last4}` : "Configured";
  }
  return f.value && f.value !== "" ? f.value : "—";
}

/** One editable setting: an input pre-filled with the current value + Save/Clear. */
function EditableRow({ field }: { field: AdminConfigField }) {
  const setConfig = useAdminSetConfig();
  const toast = useToast();
  // Secrets are write-only: the input starts empty (we never receive the value).
  const [draft, setDraft] = useState(field.secret ? "" : (field.value ?? ""));

  async function save() {
    const raw = draft.trim();
    if (field.secret && raw === "") {
      toast("Enter a value, or use Clear to remove it", "error");
      return;
    }
    // Coerce to the field's wire type; the server re-validates against the registry.
    let value: string | number | string[] = raw;
    if (field.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        toast(`${field.label} must be a number greater than 0`, "error");
        return;
      }
      value = n;
    } else if (field.type === "csv") {
      const list = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) {
        toast(`${field.label} needs at least one value`, "error");
        return;
      }
      value = list;
    }
    try {
      await setConfig.mutateAsync({ key: field.key, value });
      if (field.secret) setDraft("");
      toast(`${field.label} saved`);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
    }
  }

  async function clear() {
    try {
      await setConfig.mutateAsync({ key: field.key, value: null });
      setDraft(""); // Clear only renders for an overridden field; revert to env/default.
      toast(`${field.label} reset to environment/default`);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't clear", "error");
    }
  }

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">{field.label}</span>
          <SourceBadge source={field.source} />
        </div>
        {field.help ? <p className="text-xs text-muted">{field.help}</p> : null}
        <p className="font-mono text-[11px] text-muted">
          {field.env !== "—" ? field.env : field.key} · now: {valueLabel(field)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type={field.secret ? "password" : "text"}
          aria-label={field.label}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={field.secret ? (field.set ? "Replace key…" : "Paste key…") : field.label}
          autoComplete={field.secret ? "new-password" : "off"}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm sm:w-56"
        />
        <Button size="sm" loading={setConfig.isPending} onClick={save}>
          Save
        </Button>
        {field.overridden ? (
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** One read-only setting: shown for transparency, set via the environment only. */
function ReadonlyRow({ field }: { field: AdminConfigField }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">{field.label}</span>
          <SourceBadge source={field.source} />
        </div>
        <p className="font-mono text-[11px] text-muted">
          {field.env !== "—" ? field.env : field.key}
        </p>
      </div>
      <span
        className="shrink-0 max-w-[55%] truncate font-mono text-xs text-muted"
        title={valueLabel(field)}
      >
        {valueLabel(field)}
      </span>
    </div>
  );
}

const GROUP_ORDER = [
  "AI",
  "Email",
  "Limits",
  "Core",
  "Access",
  "Auth",
  "Database",
  "Storage",
  "Logging",
];

type SettingsFilter = "all" | "editable" | "overridden" | "secret" | "readonly";

const QUICK_FILTERS: Array<{ value: SettingsFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "editable", label: "Editable" },
  { value: "overridden", label: "Overridden" },
  { value: "secret", label: "Secrets" },
  { value: "readonly", label: "Read-only" },
];

function matchesFilter(field: AdminConfigField, filter: SettingsFilter): boolean {
  if (filter === "editable") return field.editable;
  if (filter === "overridden") return field.overridden;
  if (filter === "secret") return field.secret;
  if (filter === "readonly") return !field.editable;
  return true;
}

function searchableText(field: AdminConfigField): string {
  return [
    field.label,
    field.key,
    field.env,
    field.group,
    field.help,
    field.source,
    valueLabel(field),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Unified Configuration view: every setting with value/source, a safe editable subset. */
function Configuration() {
  const config = useAdminConfig();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SettingsFilter>("all");
  if (config.isError) {
    return (
      <Panel className="p-4">
        <p className="text-sm text-danger">Couldn't load configuration.</p>
      </Panel>
    );
  }
  if (!config.data) {
    return (
      <Panel className="p-4">
        <p className="text-sm text-muted">Loading…</p>
      </Panel>
    );
  }
  const search = query.trim().toLowerCase();
  const allFields = config.data;
  const filteredFields = allFields.filter((f) => {
    if (!matchesFilter(f, filter)) return false;
    if (!search) return true;
    return searchableText(f).includes(search);
  });

  const allByGroup = new Map<string, AdminConfigField[]>();
  for (const f of allFields) {
    const list = allByGroup.get(f.group) ?? [];
    list.push(f);
    allByGroup.set(f.group, list);
  }
  const byGroup = new Map<string, AdminConfigField[]>();
  for (const f of filteredFields) {
    const list = byGroup.get(f.group) ?? [];
    list.push(f);
    byGroup.set(f.group, list);
  }
  const groups = [...byGroup.keys()].sort(
    (a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99),
  );
  const activeFiltering = Boolean(search || filter !== "all");
  const editableCount = allFields.filter((f) => f.editable).length;
  const overriddenCount = allFields.filter((f) => f.overridden).length;

  function clearFilters() {
    setQuery("");
    setFilter("all");
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm text-muted">
          <span className="font-medium text-fg">Database</span> overrides{" "}
          <span className="font-medium text-fg">Environment</span>, which overrides the built-in
          default. Editable rows can be changed here; read-only rows move through environment
          config.
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search settings, env vars, values"
            aria-label="Search configuration settings"
          />
          {activeFiltering ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear all
            </Button>
          ) : null}
        </div>

        <FilterBar>
          {QUICK_FILTERS.map((chip) => (
            <FilterChip
              key={chip.value}
              active={filter === chip.value}
              onClick={() => setFilter(chip.value)}
            >
              {chip.label}
            </FilterChip>
          ))}
        </FilterBar>

        <p className="text-xs text-subtle">
          Showing {filteredFields.length} of {allFields.length} settings · {editableCount} editable
          · {overriddenCount} overridden
        </p>
      </div>

      {filteredFields.length === 0 ? (
        <EmptyState
          title="No settings match"
          description="Try a different search, or clear the filters to see every configuration field."
          action={
            <Button variant="secondary" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        groups.map((group) => {
          const fields = byGroup.get(group) ?? [];
          const total = allByGroup.get(group)?.length ?? fields.length;
          const groupEditable = (allByGroup.get(group) ?? []).filter((f) => f.editable).length;
          return (
            <Panel key={group} className="p-4">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-fg">{group}</h2>
                <p className="text-xs text-subtle">
                  {fields.length} of {total} settings · {groupEditable} editable
                </p>
              </div>
              <div className="divide-y divide-border">
                {fields.map((f) =>
                  f.editable ? (
                    <EditableRow key={f.key} field={f} />
                  ) : (
                    <ReadonlyRow key={f.key} field={f} />
                  ),
                )}
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}

/**
 * Admin Configuration (§6.10) — one consistent view of every setting: its
 * effective value, where it comes from (database / environment / default), and
 * whether it's editable. Secrets (e.g. the AI provider key) are write-only and
 * shown only as configured + last-4; the server never returns their value.
 */
export default function AdminSettings() {
  return (
    <div className="space-y-6">
      <AdminHeader
        title="Configuration"
        description="Database overrides environment; editable AI and quota defaults can change without restart."
      />
      <Configuration />
    </div>
  );
}
