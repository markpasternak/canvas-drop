import { useEffect, useState } from "react";
import { AdminHeader } from "../components/AdminHeader.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip } from "../components/Filters.js";
import { SearchInput } from "../components/SearchInput.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { type AdminConfigField, type AdminEmailTemplate, ApiError } from "../lib/api.js";
import {
  useAdminResetEmailTemplate,
  useAdminSetConfig,
  useAdminSetEmailTemplate,
} from "../lib/mutations.js";
import { useAdminConfig, useAdminEmailTemplates } from "../lib/queries.js";
import { commitSkin, previewSkin, restoreSkinFromCache } from "../lib/skin.js";
import { useSectionNav } from "../lib/use-section-nav.js";

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
  const serverOn = fieldOn(field);
  const [on, setOn] = useState(serverOn);
  // Re-sync when the server value changes (after a save settles or a dependency flips it).
  useEffect(() => setOn(serverOn), [serverOn]);

  async function flip(next: boolean) {
    setOn(next); // optimistic
    try {
      await setConfig.mutateAsync({ key: field.key, value: next });
      toast(`${field.label} turned ${next ? "on" : "off"}`);
    } catch (err) {
      setOn(!next); // revert
      toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
    }
  }

  async function reset() {
    try {
      await setConfig.mutateAsync({ key: field.key, value: null });
      toast(`${field.label} reset to default`);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't reset", "error");
    }
  }

  return (
    <div className="py-3">
      <Toggle
        checked={on}
        disabled={disabled}
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
        <span className="font-mono text-[11px] text-muted">
          {field.env !== "—" ? field.env : field.key}
        </span>
        {field.overridden ? (
          <Button size="sm" variant="ghost" onClick={reset}>
            Reset to default
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
  const [draft, setDraft] = useState(field.secret ? "" : (field.value ?? ""));

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
    try {
      await setConfig.mutateAsync({ key: field.key, value });
      if (isSkinField && typeof value === "string") commitSkin(value);
      if (field.secret) setDraft("");
      toast(`${field.label} saved`);
    } catch (err) {
      // A failed save must not leave the live preview on screen — revert to the committed skin.
      if (isSkinField) restoreSkinFromCache();
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
        {isSkinField ? (
          <p className="text-xs text-accent">
            Changing this previews it live across the app — Save to apply for everyone, or leave
            this page to revert.
          </p>
        ) : null}
        <p className="font-mono text-[11px] text-muted">
          {field.env !== "—" ? field.env : field.key} · now: {valueLabel(field)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {field.type === "enum" && field.enumValues ? (
          <select
            aria-label={field.label}
            value={draft}
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
            onChange={(e) => setDraft(e.target.value)}
            placeholder={field.secret ? (field.set ? "Replace key…" : "Paste key…") : field.label}
            autoComplete={field.secret ? "new-password" : "off"}
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm sm:w-56"
          />
        )}
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
    "Invite + notification emails send only when the master switch is on AND an email driver (SMTP or Mailgun) is configured. With no driver, a new invitee still joins on first sign-in — they just won't get an onboarding email.",
};

/** Anchor id for a group section (and its nav link). */
const groupAnchor = (group: string) => `cfg-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** Unified Configuration view: every setting with value/source, a safe editable subset. */
function Configuration() {
  const config = useAdminConfig();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SettingsFilter>("all");

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
      return { disabled: true, disabledReason: "Needs “Send invite & notification emails” on." };
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
              const groupEditable = (allByGroup.get(group) ?? []).filter((f) => f.editable).length;
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
  );
}

/** Friendly labels + descriptions for each known email-template key (plan 003 phase 3). */
const TEMPLATE_META: Record<string, { label: string; help: string }> = {
  account_invite: {
    label: "Account invite",
    help: "Sent when an admin adds a new person — invites them to sign in for the first time.",
  },
  canvas_invite: {
    label: "Canvas shared (Specific people)",
    help: "Sent when an existing user is given access to a canvas via the Specific-people rung.",
  },
  individual_canvas_invite: {
    label: "Individual canvas invite",
    help: "Sent for a one-off invite of a person to a single canvas.",
  },
  team_invite: {
    label: "Team invite",
    help: "Sent to a brand-new person added to a team, so they can sign in and see what's shared.",
  },
};

/** Available `{{variables}}` for guidance in the editor (the server allow-lists these). */
const TEMPLATE_VARS =
  "{{name}} · {{inviterName}} · {{instanceName}} · {{canvasTitle}} · {{teamName}} · {{link}}";

/** One email template: editable subject + HTML body + text body, with Save and Reset. */
function TemplateRow({ template }: { template: AdminEmailTemplate }) {
  const setTemplate = useAdminSetEmailTemplate();
  const resetTemplate = useAdminResetEmailTemplate();
  const toast = useToast();
  const meta = TEMPLATE_META[template.key];
  const [subject, setSubject] = useState(template.subject);
  const [bodyHtml, setBodyHtml] = useState(template.bodyHtml);
  const [bodyText, setBodyText] = useState(template.bodyText);

  // Re-sync local drafts when the server value changes (after a save/reset refetch).
  useEffect(() => {
    setSubject(template.subject);
    setBodyHtml(template.bodyHtml);
    setBodyText(template.bodyText);
  }, [template.subject, template.bodyHtml, template.bodyText]);

  async function save() {
    if (!subject.trim() || !bodyHtml.trim() || !bodyText.trim()) {
      toast("Subject, HTML body, and text body are all required", "error");
      return;
    }
    try {
      await setTemplate.mutateAsync({ key: template.key, body: { subject, bodyHtml, bodyText } });
      toast(`${meta?.label ?? template.key} saved`);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
    }
  }

  async function reset() {
    try {
      await resetTemplate.mutateAsync(template.key);
      toast(`${meta?.label ?? template.key} reset to default`);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't reset", "error");
    }
  }

  const inputClass = "w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm font-mono";

  return (
    <div className="space-y-2 py-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-fg">{meta?.label ?? template.key}</span>
        {template.overridden ? <Badge tone="success">Customized</Badge> : <Badge>Default</Badge>}
      </div>
      {meta?.help ? <p className="text-xs text-muted">{meta.help}</p> : null}
      <label className="block space-y-1">
        <span className="text-xs text-subtle">Subject</span>
        <input
          aria-label={`${meta?.label ?? template.key} subject`}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-subtle">HTML body</span>
        <textarea
          aria-label={`${meta?.label ?? template.key} HTML body`}
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          rows={4}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-subtle">Text body</span>
        <textarea
          aria-label={`${meta?.label ?? template.key} text body`}
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          rows={3}
          className={inputClass}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" loading={setTemplate.isPending} onClick={save}>
          Save
        </Button>
        {template.overridden ? (
          <Button size="sm" variant="ghost" loading={resetTemplate.isPending} onClick={reset}>
            Reset to default
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Admin email-template editor: each invite/notification email, subject + HTML + text. */
function EmailTemplates() {
  const templates = useAdminEmailTemplates();
  if (templates.isError) {
    return (
      <Panel className="p-4">
        <p className="text-sm text-danger">Couldn't load email templates.</p>
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
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-fg">Email templates</h2>
        <p className="text-xs text-muted">
          Customize the invite and notification emails. Variables:{" "}
          <span className="font-mono">{TEMPLATE_VARS}</span> (HTML-escaped in the HTML body).
          Unknown variables render empty.
        </p>
      </div>
      <div className="divide-y divide-border">
        {templates.data.map((t) => (
          <TemplateRow key={t.key} template={t} />
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
  return (
    <div className="space-y-6">
      <AdminHeader
        title="Configuration"
        description="Database overrides environment; editable AI and quota defaults can change without restart."
      />
      <Configuration />
      <EmailTemplates />
    </div>
  );
}
