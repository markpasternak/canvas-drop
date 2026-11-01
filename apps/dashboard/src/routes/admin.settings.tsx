import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AdminHeader } from "../components/AdminHeader.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip } from "../components/Filters.js";
import { PendingChangesGuard } from "../components/PendingChangesGuard.js";
import { ReadError } from "../components/ReadError.js";
import { SearchInput } from "../components/SearchInput.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { type AdminConfigField, type AdminEmailTemplate, ApiError } from "../lib/api.js";
import { emailPreviewDocument } from "../lib/email-preview.js";
import {
  useAdminResetEmailTemplate,
  useAdminSetConfig,
  useAdminSetEmailTemplate,
} from "../lib/mutations.js";
import { useAdminConfig, useAdminEmailTemplates } from "../lib/queries.js";
import { commitSkin, previewSkin, restoreSkinFromCache } from "../lib/skin.js";
import { useSectionNav } from "../lib/use-section-nav.js";

const ConfigDraftContext = createContext<{
  drafts: Record<string, string>;
  change: (key: string, value: string | null) => void;
  refresh: () => Promise<{ isError: boolean }>;
  acknowledged: Record<string, boolean>;
  acknowledge: (key: string, saved: boolean) => void;
  pending: Record<string, boolean>;
  errors: Record<string, string>;
  setError: (key: string, error: string) => void;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
} | null>(null);

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
  // Booleans read as On/Off, not a bare "true"/"false" (matches the editor control).
  if (f.type === "boolean") return f.value === "true" ? "On" : "Off";
  return f.value && f.value !== "" ? f.value : "—";
}

/** A boolean config field's current on/off — narrows past the secret union member
 *  (boolean fields are never secret, so `value` is always present). */
function fieldOn(f: AdminConfigField): boolean {
  return !f.secret && f.value === "true";
}

/** One editable setting. Dispatches by type so each value gets a control that's hard to
 *  mis-set: a boolean is a real On/Off switch, never a free-text "true"/"false" box. A
 *  `disabled` gate (+ reason) lets a parent express a dependency, e.g. the email sub-toggles
 *  do nothing until the master switch is on. */
export function EditableRow({
  field,
  disabled,
  disabledReason,
}: {
  field: AdminConfigField;
  disabled?: boolean;
  disabledReason?: string;
}) {
  if (field.type === "boolean") {
    return <BooleanRow field={field} disabled={disabled} disabledReason={disabledReason} />;
  }
  return <DraftRow field={field} />;
}

/** A boolean setting as a switch that saves the instant you flip it (no Save button to
 *  forget). Optimistic; reverts on error. A `disabled` gate greys it out with a reason. */
function BooleanRow({
  field,
  disabled,
  disabledReason,
}: {
  field: AdminConfigField;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const setConfig = useAdminSetConfig();
  const toast = useToast();
  const context = useContext(ConfigDraftContext);
  const pending = setConfig.isPending || Boolean(context?.pending[field.key]);
  const run = (action: () => Promise<void>) =>
    context ? context.run(field.key, action) : action();
  const serverOn = fieldOn(field);
  const [on, setOn] = useState(serverOn);
  // Re-sync when the server value changes (after a save settles or a dependency flips it).
  useEffect(() => setOn(serverOn), [serverOn]);

  async function flip(next: boolean) {
    await run(async () => {
      setOn(next); // optimistic
      try {
        await setConfig.mutateAsync({ key: field.key, value: next });
        const refreshed = await context?.refresh();
        if (refreshed?.isError) {
          toast(
            "Change saved, but the effective value could not be refreshed. Try refreshing configuration.",
            "error",
          );
          return;
        }
        toast(`${field.label} turned ${next ? "on" : "off"}`);
      } catch (err) {
        setOn(!next); // revert
        toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
      }
    });
  }

  async function reset() {
    await run(async () => {
      try {
        await setConfig.mutateAsync({ key: field.key, value: null });
        const refreshed = await context?.refresh();
        if (refreshed?.isError) {
          toast(
            "Override removed, but the effective value could not be refreshed. Try refreshing configuration.",
            "error",
          );
          return;
        }
        toast(`${field.label} reset to environment/default`);
      } catch (err) {
        toast(err instanceof ApiError ? err.hint : "Couldn't reset", "error");
      }
    });
  }

  return (
    <div className="py-3">
      <Toggle
        checked={on}
        disabled={disabled || pending}
        onChange={flip}
        label={
          <span className="inline-flex items-center gap-2">
            {field.label}
            <SourceBadge source={field.source} />
          </span>
        }
        description={
          <>
            {field.help}
            {disabled && disabledReason ? (
              <span className="mt-0.5 block text-warning">{disabledReason}</span>
            ) : null}
          </>
        }
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="break-all font-mono text-xs text-muted">
          {field.env !== "—" ? field.env : field.key}
        </span>
        {field.overridden ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
            Reset override
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A non-boolean setting edited via a draft + explicit Save/Clear (numbers, lists, secrets,
 *  enums). Numbers use a real numeric input; secrets are write-only (start empty). */
function DraftRow({ field }: { field: AdminConfigField }) {
  const setConfig = useAdminSetConfig();
  const toast = useToast();
  // Secrets are write-only: the input starts empty (we never receive the value).
  const context = useContext(ConfigDraftContext);
  const [localDraft, setLocalDraft] = useState<string | null>(null);
  const baseline = field.secret ? "" : (field.value ?? "");
  const draft = context ? (context.drafts[field.key] ?? baseline) : (localDraft ?? baseline);
  const acknowledged = Boolean(context?.acknowledged[field.key]);
  const dirty = draft !== baseline && !acknowledged;
  const [localError, setLocalError] = useState("");
  const [localPending, setLocalPending] = useState(false);
  const pending = context ? Boolean(context.pending[field.key]) : localPending;
  const error = context ? (context.errors[field.key] ?? "") : localError;
  const setError = (message: string) =>
    context ? context.setError(field.key, message) : setLocalError(message);
  const run = async (action: () => Promise<void>) => {
    if (context) return context.run(field.key, action);
    if (localPending) return;
    setLocalPending(true);
    try {
      await action();
    } finally {
      setLocalPending(false);
    }
  };
  const setDraft = (value: string | null) => {
    if (context) context.change(field.key, value === baseline ? null : value);
    else setLocalDraft(value);
    context?.acknowledge(field.key, false);
    setError("");
  };

  // The design-skin field previews live across the whole app as the admin picks (they
  // see the real thing, not a swatch); leaving without saving reverts to the cached
  // real skin. Save commits it. See lib/skin.ts.
  const isSkinField = field.key === "core.designSkin";
  useEffect(() => {
    if (!isSkinField) return;
    return () => restoreSkinFromCache();
  }, [isSkinField]);

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
    await run(async () => {
      try {
        await setConfig.mutateAsync({ key: field.key, value });
        if (isSkinField && typeof value === "string") commitSkin(value);
        context?.acknowledge(field.key, true);
        const refreshed = await context?.refresh();
        if (refreshed?.isError) {
          setError(
            "Change saved, but the effective value couldn't be refreshed. The entered value is retained here. Retry the refresh before relying on the inherited value.",
          );
          return;
        }
        setDraft(null);
        toast(`${field.label} saved`);
      } catch (err) {
        // A failed save must not leave the live preview on screen — revert to the committed skin.
        if (isSkinField) restoreSkinFromCache();
        setError(
          err instanceof ApiError
            ? err.hint
            : "Couldn't save. Your change is still here; try Save again.",
        );
      }
    });
  }

  async function clear() {
    await run(async () => {
      try {
        await setConfig.mutateAsync({ key: field.key, value: null });
        context?.acknowledge(field.key, true);
        const refreshed = await context?.refresh();
        if (refreshed?.isError) {
          setError(
            "Change saved, but the effective value couldn't be refreshed. The entered value is retained here. Retry the refresh before relying on the inherited value.",
          );
          return;
        }
        setDraft(null);
        if (isSkinField) restoreSkinFromCache();
        toast(`${field.label} reset to environment/default`);
      } catch (err) {
        setError(err instanceof ApiError ? err.hint : "Couldn't reset the override. Try again.");
      }
    });
  }

  return (
    <div className="space-y-2 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg">{field.label}</span>
          <SourceBadge source={field.source} />
          {dirty && <Badge tone="warning">Unsaved</Badge>}
          {acknowledged && <Badge>Saved · awaiting refresh</Badge>}
        </div>
        {field.help ? <p className="text-xs text-muted">{field.help}</p> : null}
        {isSkinField ? (
          <p className="text-xs text-accent">
            Changing this previews it live across the app — Save to apply for everyone, or leave
            this page to revert.
          </p>
        ) : null}
        <p className="break-all font-mono text-xs text-muted">
          {field.env !== "—" ? field.env : field.key} · {acknowledged ? "last loaded" : "now"}:{" "}
          {valueLabel(field)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {field.type === "enum" && field.enumValues ? (
          <select
            aria-label={field.label}
            value={draft}
            disabled={pending}
            onChange={(e) => {
              setDraft(e.target.value);
              if (isSkinField) previewSkin(e.target.value);
            }}
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm sm:w-56"
          >
            {field.enumValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <input
            type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
            inputMode={field.type === "number" ? "numeric" : undefined}
            min={field.type === "number" ? 1 : undefined}
            aria-label={field.label}
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={field.secret ? (field.set ? "Replace key…" : "Paste key…") : field.label}
            autoComplete={field.secret ? "new-password" : "off"}
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm sm:w-56"
          />
        )}
        {acknowledged && (
          <Button
            size="sm"
            loading={pending}
            onClick={() =>
              run(async () => {
                const refreshed = await context?.refresh();
                if (!refreshed?.isError) setDraft(null);
              })
            }
          >
            Refresh effective value
          </Button>
        )}
        {dirty && (
          <Button size="sm" loading={pending} onClick={save}>
            Save
          </Button>
        )}
        {(dirty || acknowledged) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setDraft(null);
              if (isSkinField) restoreSkinFromCache();
            }}
          >
            Discard
          </Button>
        )}
        {field.overridden ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={clear}>
            Reset override
          </Button>
        ) : null}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** One read-only setting: shown for transparency, set via the environment only. */
function ReadonlyRow({ field }: { field: AdminConfigField }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg">{field.label}</span>
          <SourceBadge source={field.source} />
        </div>
        <p className="break-all font-mono text-xs text-muted">
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
  { value: "all", label: "All configuration" },
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

// Cross-field dependencies (error-prevention): a setting that has no effect until another is
// on. The email notify toggles do nothing while the master send switch is off.
const EMAIL_MASTER = "email.invitesEnabled";
const EMAIL_SUBS = new Set([
  "email.notifyOnAddUser",
  "email.notifyOnCanvasAdd",
  "email.notifyOnCanvasInvite",
]);

/** A short intro note for a group, shown under its heading. */
const GROUP_NOTES: Record<string, string> = {
  Email:
    "Access emails send only when the master switch is on AND an email driver (SMTP or Mailgun) is configured. With no driver, a new person can still join on first sign-in — they just won't get an onboarding email.",
};

/** Anchor id for a group section (and its nav link). */
const groupAnchor = (group: string) => `cfg-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** Unified Configuration view: every setting with value/source, a safe editable subset. */
function Configuration({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const config = useAdminConfig();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SettingsFilter>("editable");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftRevisions = useRef<Record<string, number>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const acknowledge = (key: string, saved: boolean) =>
    setAcknowledged((current) => ({ ...current, [key]: saved }));
  const activeWrites = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const setError = (key: string, error: string) =>
    setErrors((current) => ({ ...current, [key]: error }));
  const run = async (key: string, action: () => Promise<void>) => {
    if (activeWrites.current.has(key)) return;
    activeWrites.current.add(key);
    setPending((current) => ({ ...current, [key]: true }));
    try {
      await action();
    } finally {
      activeWrites.current.delete(key);
      setPending((current) => ({ ...current, [key]: false }));
    }
  };
  const dirtyCount = Object.keys(drafts).filter((key) => !acknowledged[key]).length;
  const anyPending = Object.values(pending).some(Boolean);
  useEffect(
    () => onDirtyChange(dirtyCount > 0 || anyPending),
    [dirtyCount, anyPending, onDirtyChange],
  );
  const change = (key: string, value: string | null) => {
    draftRevisions.current[key] = (draftRevisions.current[key] ?? 0) + 1;
    setDrafts((current) => {
      const next = { ...current };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const refresh = async () => {
    const revisions = { ...draftRevisions.current };
    const result = await config.refetch();
    if (!result.isError) {
      for (const key of Object.keys(acknowledged)) {
        if (
          !acknowledged[key] ||
          activeWrites.current.has(key) ||
          revisions[key] !== draftRevisions.current[key]
        )
          continue;
        change(key, null);
        acknowledge(key, false);
        setError(key, "");
      }
    }
    return result;
  };

  // Derive everything from `config.data ?? []` so the hooks below (useSectionNav) run on every
  // render — even while loading — keeping hook order stable (React's rules of hooks).
  const allFields = config.data ?? [];
  const search = query.trim().toLowerCase();
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

  // In-page section nav (mirrors the canvas detail tabs). Active = the section you're scrolled to.
  const sectionIds = groups.map(groupAnchor);
  const { active, select } = useSectionNav(sectionIds, !!config.data);

  const byKey = new Map(allFields.map((f) => [f.key, f]));
  /** Whether a field is gated off by a dependency (with a reason to show). */
  const gateOf = (field: AdminConfigField): { disabled?: boolean; disabledReason?: string } => {
    const master = byKey.get(EMAIL_MASTER);
    if (EMAIL_SUBS.has(field.key) && master && !fieldOn(master)) {
      return { disabled: true, disabledReason: "Needs “Send access emails” on." };
    }
    return {};
  };

  const activeFiltering = Boolean(search || filter !== "all");
  const editableCount = allFields.filter((f) => f.editable).length;
  const overriddenCount = allFields.filter((f) => f.overridden).length;

  function clearFilters() {
    setQuery("");
    setFilter("all");
  }

  if (config.isError && !config.data) {
    return (
      <Panel className="p-4">
        <ReadError
          title="Couldn't load configuration"
          onRetry={() => void refresh()}
          retrying={config.isFetching}
        />
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

  return (
    <ConfigDraftContext.Provider
      value={{ drafts, change, refresh, pending, errors, setError, run, acknowledged, acknowledge }}
    >
      <div className="space-y-5">
        {config.isError && (
          <ReadError
            title="Couldn’t refresh configuration"
            onRetry={() => void refresh()}
            retrying={config.isFetching}
          >
            Your edits are still here. Saved values may be out of date.
          </ReadError>
        )}
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

          {dirtyCount > 0 && (
            <p role="status" className="text-sm text-warning">
              {dirtyCount} unsaved setting{dirtyCount === 1 ? "" : "s"}. Drafts stay here when you
              search or change filters.
            </p>
          )}
          <p className="text-xs text-subtle">
            Showing {filteredFields.length} of {allFields.length} settings · {editableCount}{" "}
            editable · {overriddenCount} overridden
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
          <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start lg:gap-8">
            <SettingsNav
              sections={groups.map((g) => ({ id: groupAnchor(g), label: g }))}
              active={active}
              onSelect={select}
              ariaLabel="Configuration sections"
            />
            <div className="space-y-5">
              {groups.map((group) => {
                const fields = byGroup.get(group) ?? [];
                const total = allByGroup.get(group)?.length ?? fields.length;
                const groupEditable = (allByGroup.get(group) ?? []).filter(
                  (f) => f.editable,
                ).length;
                return (
                  <section key={group} id={groupAnchor(group)} className="scroll-mt-24">
                    <Panel className="p-4">
                      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                        <h2 className="text-sm font-semibold text-fg">{group}</h2>
                        <p className="text-xs text-subtle">
                          {fields.length} of {total} settings · {groupEditable} editable
                        </p>
                      </div>
                      {GROUP_NOTES[group] ? (
                        <p className="mb-2 rounded-md bg-surface-sunken px-3 py-2 text-xs text-muted">
                          {GROUP_NOTES[group]}
                        </p>
                      ) : null}
                      <div className="divide-y divide-border">
                        {fields.map((f) =>
                          f.editable ? (
                            <EditableRow key={f.key} field={f} {...gateOf(f)} />
                          ) : (
                            <ReadonlyRow key={f.key} field={f} />
                          ),
                        )}
                      </div>
                    </Panel>
                  </section>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </ConfigDraftContext.Provider>
  );
}

/** Friendly labels + descriptions for each known email-template key (plan 003 phase 3). */
const TEMPLATE_META: Record<string, { label: string; help: string }> = {
  account_invite: {
    label: "Sign-in permit",
    help: "Sent when an admin permits a new email to sign in.",
  },
  canvas_invite: {
    label: "Added to a canvas",
    help: "Sent when a person is added under People and teams with direct access.",
  },
  individual_canvas_invite: {
    label: "Individual canvas access",
    help: "Sent when a person is deliberately given one-canvas access.",
  },
  team_invite: {
    label: "Team access",
    help: "Sent to a brand-new person added to a team, so they can sign in and see what's shared.",
  },
};

/** Available `{{variables}}` for guidance in the editor (the server allow-lists these). */
const TEMPLATE_VARS =
  "{{recipientEmail}} · {{name}} · {{inviterName}} · {{canvasTitle}} · {{teamName}} · {{link}}";

/** One email template: editable subject + HTML body + text body, with Save and Reset. */
function TemplateRow({
  template,
  onDirtyChange,
  refresh,
  refreshEpoch,
  getRefreshGeneration,
}: {
  template: AdminEmailTemplate;
  onDirtyChange: (key: string, dirty: boolean) => void;
  refresh: () => Promise<{ isError: boolean }>;
  refreshEpoch: number;
  getRefreshGeneration: () => number;
}) {
  const setTemplate = useAdminSetEmailTemplate();
  const resetTemplate = useAdminResetEmailTemplate();
  const toast = useToast();
  const meta = TEMPLATE_META[template.key];
  const [draft, setDraft] = useState<Pick<
    AdminEmailTemplate,
    "subject" | "bodyHtml" | "bodyText"
  > | null>(null);
  const { subject, bodyHtml, bodyText } = draft ?? template;
  const [acknowledged, setAcknowledged] = useState<"saved" | "reset" | null>(null);
  const revision = useRef(0);
  const acknowledgedAt = useRef({ epoch: refreshEpoch, revision: 0 });
  const [busy, setBusy] = useState(false);
  const pending = busy || setTemplate.isPending || resetTemplate.isPending;
  const dirty =
    !acknowledged &&
    (subject !== template.subject ||
      bodyHtml !== template.bodyHtml ||
      bodyText !== template.bodyText);
  const [error, setError] = useState("");
  useEffect(() => {
    if (
      !acknowledged ||
      refreshEpoch <= acknowledgedAt.current.epoch ||
      revision.current !== acknowledgedAt.current.revision
    )
      return;
    setDraft(null);
    setAcknowledged(null);
    setError("");
  }, [acknowledged, refreshEpoch]);
  const edit = (key: "subject" | "bodyHtml" | "bodyText", value: string) => {
    revision.current += 1;
    setDraft({ subject, bodyHtml, bodyText, [key]: value });
    setAcknowledged(null);
    setError("");
  };
  useEffect(() => onDirtyChange(template.key, dirty), [template.key, dirty, onDirtyChange]);

  async function write(operation: "save" | "reset") {
    if (pending) return;
    if (operation === "save" && (!subject.trim() || !bodyHtml.trim() || !bodyText.trim())) {
      toast("Subject, HTML body, and text body are all required", "error");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (operation === "save") {
        await setTemplate.mutateAsync({ key: template.key, body: { subject, bodyHtml, bodyText } });
      } else await resetTemplate.mutateAsync(template.key);
      acknowledgedAt.current = { epoch: getRefreshGeneration(), revision: revision.current };
      setAcknowledged(operation === "save" ? "saved" : "reset");
      const result = await refresh();
      if (result.isError) {
        setError(
          operation === "save"
            ? "Template saved, but the current template couldn't be refreshed. Your entered content is retained here. Refresh to see the effective template."
            : "Override removed, but the default template couldn't be refreshed. Your entered content is retained here. Refresh to see the current default.",
        );
        return;
      }
      setDraft(null);
      setAcknowledged(null);
      toast(
        `${meta?.label ?? template.key} ${operation === "save" ? "saved" : "reset to default"}`,
      );
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.hint
          : "Couldn't change this template. Your edits are still here.",
      );
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm font-mono";

  return (
    <div className="space-y-2 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">{meta?.label ?? template.key}</span>
        <Badge tone={template.overridden ? "success" : "neutral"}>
          {acknowledged ? "Last loaded · " : ""}
          {template.overridden ? "Customized" : "Default"}
        </Badge>
        {dirty && <Badge tone="warning">Unsaved</Badge>}
        {acknowledged && (
          <Badge>{acknowledged === "saved" ? "Saved" : "Reset"} · awaiting refresh</Badge>
        )}
      </div>
      {meta?.help ? <p className="text-xs text-muted">{meta.help}</p> : null}
      <label className="block space-y-1">
        <span className="text-xs text-subtle">Subject</span>
        <input
          aria-label={`${meta?.label ?? template.key} subject`}
          value={subject}
          onChange={(e) => edit("subject", e.target.value)}
          disabled={pending}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-subtle">HTML body</span>
        <textarea
          aria-label={`${meta?.label ?? template.key} HTML body`}
          value={bodyHtml}
          onChange={(e) => edit("bodyHtml", e.target.value)}
          disabled={pending}
          rows={4}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-subtle">Text body</span>
        <textarea
          aria-label={`${meta?.label ?? template.key} text body`}
          value={bodyText}
          onChange={(e) => edit("bodyText", e.target.value)}
          disabled={pending}
          rows={3}
          className={inputClass}
        />
      </label>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm text-accent">Preview email</summary>
        <p className="text-xs text-muted">
          Illustrative values, rendered locally. No email is sent; external images and links are
          disabled.
        </p>
        <iframe
          title={`${meta?.label ?? template.key} email preview`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={emailPreviewDocument(bodyHtml)}
          className="h-72 w-full rounded-md border border-border bg-surface"
        />
      </details>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {dirty && (
          <Button
            size="sm"
            loading={pending && !resetTemplate.isPending}
            disabled={pending}
            onClick={() => void write("save")}
          >
            Save
          </Button>
        )}
        {acknowledged && (
          <Button size="sm" disabled={pending} onClick={() => void refresh()}>
            Refresh effective template
          </Button>
        )}
        {(dirty || acknowledged) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              revision.current += 1;
              setDraft(null);
              setAcknowledged(null);
              setError("");
            }}
          >
            Discard
          </Button>
        )}
        {template.overridden ? (
          <Button
            size="sm"
            variant="ghost"
            loading={resetTemplate.isPending}
            disabled={pending}
            onClick={() => void write("reset")}
          >
            Reset to latest default
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Admin email-template editor: each sign-in/access email, subject + HTML + text. */
function EmailTemplates({
  onDirtyChange,
}: {
  onDirtyChange: (key: string, dirty: boolean) => void;
}) {
  const templates = useAdminEmailTemplates();
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const refreshGeneration = useRef(0);
  const getRefreshGeneration = () => refreshGeneration.current;
  const refresh = async () => {
    // Only reads started after a write acknowledgement can reconcile its buffer.
    const generation = ++refreshGeneration.current;
    const result = await templates.refetch();
    if (!result.isError) setRefreshEpoch((current) => Math.max(current, generation));
    return result;
  };
  if (templates.isError && !templates.data) {
    return (
      <Panel className="p-4">
        <ReadError
          title="Couldn't load email templates"
          onRetry={() => void refresh()}
          retrying={templates.isFetching}
        />
      </Panel>
    );
  }
  if (!templates.data) {
    return (
      <Panel className="p-4">
        <p className="text-sm text-muted">Loading…</p>
      </Panel>
    );
  }
  return (
    <Panel className="p-4">
      {templates.isError && (
        <ReadError
          title="Couldn’t refresh email templates"
          onRetry={() => void refresh()}
          retrying={templates.isFetching}
        >
          Your edits are still here. Saved templates may be out of date.
        </ReadError>
      )}
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-fg">Email templates</h2>
        <p className="text-xs text-muted">
          Customize the sign-in and access emails. Variables:{" "}
          <span className="font-mono">{TEMPLATE_VARS}</span> (HTML-escaped in the HTML body).
          Unknown variables render empty. Reset uses the latest seeded default.
        </p>
      </div>
      <div className="divide-y divide-border">
        {templates.data.map((t) => (
          <TemplateRow
            key={t.key}
            template={t}
            onDirtyChange={onDirtyChange}
            refresh={refresh}
            refreshEpoch={refreshEpoch}
            getRefreshGeneration={getRefreshGeneration}
          />
        ))}
      </div>
    </Panel>
  );
}

/**
 * Admin Configuration (§6.10) — one consistent view of every setting: its
 * effective value, where it comes from (database / environment / default), and
 * whether it's editable. Secrets (e.g. the AI provider key) are write-only and
 * shown only as configured + last-4; the server never returns their value.
 */
export default function AdminSettings() {
  const [configDirty, setConfigDirty] = useState(false);
  const [templateDirty, setTemplateDirty] = useState<Record<string, boolean>>({});
  const markTemplate = useCallback(
    (key: string, dirty: boolean) =>
      setTemplateDirty((current) =>
        current[key] === dirty ? current : { ...current, [key]: dirty },
      ),
    [],
  );
  return (
    <div className="space-y-6">
      <AdminHeader
        title="Configuration"
        description="Database overrides environment; editable AI and quota defaults can change without restart."
      />
      <Configuration onDirtyChange={setConfigDirty} />
      <EmailTemplates onDirtyChange={markTemplate} />
      <PendingChangesGuard dirty={configDirty || Object.values(templateDirty).some(Boolean)} />
    </div>
  );
}
