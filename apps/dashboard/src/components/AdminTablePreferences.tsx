import { useState } from "react";

export const OPTIONAL_ADMIN_COLUMNS = [
  { key: "owner", label: "Owner" },
  { key: "size", label: "Size" },
  { key: "usage", label: "Usage" },
  { key: "activity", label: "Last activity" },
] as const;
export type AdminColumn = (typeof OPTIONAL_ADMIN_COLUMNS)[number]["key"];
export interface AdminTableSettings {
  hidden: AdminColumn[];
  compact: boolean;
}
const DEFAULT: AdminTableSettings = { hidden: [], compact: true };

export function useAdminTablePreferences(userId: string | undefined) {
  const key = `admin:canvas-table:v1:${userId ?? "anonymous"}`;
  const [state, setState] = useState<{ key: string; value: AdminTableSettings }>(() => ({
    key: "",
    value: DEFAULT,
  }));
  let value = state.value;
  if (state.key !== key) {
    value = DEFAULT;
    if (userId) {
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
        if (
          stored &&
          typeof stored === "object" &&
          "hidden" in stored &&
          Array.isArray(stored.hidden) &&
          "compact" in stored
        ) {
          const hidden = stored.hidden;
          value = {
            hidden: OPTIONAL_ADMIN_COLUMNS.filter((c) => hidden.includes(c.key)).map((c) => c.key),
            compact: stored.compact !== false,
          };
        }
      } catch {
        /* An unavailable browser store uses defaults. */
      }
    }
    setState({ key, value });
  }
  const update = (next: AdminTableSettings) => {
    setState({ key, value: next });
    if (userId) {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Still usable for this session. */
      }
    }
  };
  return [value, update] as const;
}

export function AdminTablePreferences({
  value,
  onChange,
}: {
  value: AdminTableSettings;
  onChange: (value: AdminTableSettings) => void;
}) {
  return (
    <details className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-fg">Table display</summary>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
        {OPTIONAL_ADMIN_COLUMNS.map(({ key, label }) => (
          <label key={key} className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={!value.hidden.includes(key)}
              onChange={(event) =>
                onChange({
                  ...value,
                  hidden: event.target.checked
                    ? value.hidden.filter((c) => c !== key)
                    : [...value.hidden, key],
                })
              }
            />
            {label}
          </label>
        ))}
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={value.compact}
            onChange={(event) => onChange({ ...value, compact: event.target.checked })}
          />
          Compact rows
        </label>
      </div>
    </details>
  );
}
