import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { Field, TextareaField } from "../components/Field.js";
import { PageHeader, Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { type AdminQuota, ApiError } from "../lib/api.js";
import { useAdminSetModels, useAdminSetQuotas } from "../lib/mutations.js";
import { useAdminModels, useAdminQuotas } from "../lib/queries.js";

/** The editable allowlist form. Mounts only AFTER the data loads, so its
 *  `useState` initializer captures the server value once — an effect that re-seeds
 *  on every query settle would clobber in-progress edits (dashboard-spa: seed on
 *  first data, not on the query object). */
function ModelAllowlistForm({ initial }: { initial: string[] }) {
  const [text, setText] = useState(initial.join(", "));
  const setModels = useAdminSetModels();
  const toast = useToast();
  return (
    <>
      <TextareaField
        label="Allowed models"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        mono
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          loading={setModels.isPending}
          onClick={async () => {
            const list = text
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean);
            if (list.length === 0) {
              toast("At least one model is required", "error");
              return;
            }
            try {
              await setModels.mutateAsync(list);
              toast("Model allowlist saved");
            } catch (err) {
              toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
            }
          }}
        >
          Save allowlist
        </Button>
      </div>
    </>
  );
}

/** Model allowlist editor (§6.10.3) — comma-separated plain model IDs. */
function ModelAllowlist() {
  const models = useAdminModels();
  return (
    <Panel className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-fg">AI model allowlist</h2>
        <p className="text-xs text-muted">
          Models canvases may call once the AI primitive ships. Comma-separated IDs.
        </p>
      </div>
      {models.data ? (
        <ModelAllowlistForm initial={models.data.models} />
      ) : (
        <p className="text-sm text-muted">Loading…</p>
      )}
    </Panel>
  );
}

const QUOTA_LABELS: Record<string, string> = {
  "kv.keys.shared": "KV keys (shared)",
  "kv.keys.user": "KV keys (per user)",
  "files.bytes.file": "Max file size (bytes)",
  "files.bytes.canvas": "Files per canvas (bytes)",
  "ai.user.daily.usd": "AI $/user/day",
  "ai.canvas.monthly.usd": "AI $/canvas/month",
};

/** Global quota defaults editor (§6.10.4). */
function QuotaDefaults() {
  const quotas = useAdminQuotas();
  const setQuotas = useAdminSetQuotas();
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});

  const valueFor = (q: AdminQuota) => edits[q.key] ?? String(q.value);

  return (
    <Panel className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-fg">Global quota defaults</h2>
        <p className="text-xs text-muted">
          Platform-wide defaults. Per-canvas overrides arrive later.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {quotas.data?.map((q) => (
          <Field
            key={q.key}
            label={QUOTA_LABELS[q.key] ?? q.key}
            hint={q.override === null ? "default" : "overridden"}
            inputMode="numeric"
            value={valueFor(q)}
            onChange={(e) => setEdits((prev) => ({ ...prev, [q.key]: e.target.value }))}
          />
        ))}
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          loading={setQuotas.isPending}
          disabled={Object.keys(edits).length === 0}
          onClick={async () => {
            const patch: Record<string, number> = {};
            for (const [key, raw] of Object.entries(edits)) {
              const n = Number(raw);
              if (!Number.isFinite(n) || n <= 0) {
                toast(`${QUOTA_LABELS[key] ?? key} must be a positive number`, "error");
                return;
              }
              patch[key] = n;
            }
            try {
              await setQuotas.mutateAsync(patch);
              setEdits({});
              toast("Quota defaults saved");
            } catch (err) {
              toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");
            }
          }}
        >
          Save quotas
        </Button>
      </div>
    </Panel>
  );
}

/** Admin settings (§6.10.3/4) — model allowlist + global quota defaults. */
export default function AdminSettings() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin settings"
        description="Platform defaults consumed by the primitives and (soon) the AI proxy."
        actions={
          <Link to="/admin" className="text-sm font-medium text-accent">
            Back to admin
          </Link>
        }
      />
      <ModelAllowlist />
      <QuotaDefaults />
    </div>
  );
}
