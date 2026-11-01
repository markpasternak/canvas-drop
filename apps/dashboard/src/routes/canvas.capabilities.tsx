import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "../components/Badge.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { PendingChangesGuard } from "../components/PendingChangesGuard.js";
import { ReadError } from "../components/ReadError.js";
import { RuntimePolicySettings } from "../components/RuntimePolicySettings.js";
import { Row, RowDivider, Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { ApiError, type FeatureCapability } from "../lib/api.js";
import { useUpdateCapabilities } from "../lib/mutations.js";
import { useCanvas, useCanvasConnections } from "../lib/queries.js";

/**
 * Backend-group features (plan 006). Mirrors the shared capability taxonomy — the
 * dashboard bundle is intentionally free of workspace `shared` imports, so the
 * labels live here; the server is authoritative for stored + effective state.
 */
const BACKEND_FEATURES: { key: FeatureCapability; label: string; description: string }[] = [
  {
    key: "kv",
    label: "Key-value storage",
    description: "Shared content, private preferences, and participant submissions.",
  },
  {
    key: "files",
    label: "File storage",
    description: "Upload, list, and serve files from the canvas.",
  },
  {
    key: "ai",
    label: "AI",
    description:
      "Use AI through the server, for example to summarize text. Provider keys stay on the server.",
  },
  {
    key: "realtime",
    label: "Realtime",
    description: "Live updates and presence, for example shared cursors or a live poll.",
  },
  {
    key: "authoring",
    label: "Authoring",
    description:
      "Let signed-in viewers create a new canvas from this page, as themselves. Off by default.",
  },
];

/**
 * Capabilities tab (plan 006). One "Backend" group: a master switch plus the four
 * backend features. Feature toggles are disabled while backend is off; a feature
 * the operator has globally disabled shows a hint. Identity (`me()`) is always on
 * when backend is enabled. Toggles are optimistic (useUpdateCapabilities).
 */
export default function Capabilities() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <CanvasCapabilities key={id} id={id} />;
}

function CanvasCapabilities({ id }: { id: string }) {
  const toast = useToast();
  const { data: canvas, isLoading } = useCanvas(id);
  const connections = useCanvasConnections(id);
  const update = useUpdateCapabilities(id);
  const [policyDirty, setPolicyDirty] = useState(false);

  if (isLoading || !canvas) {
    return <Skeleton className="h-64" />;
  }

  const onSaveError = (err: unknown) =>
    toast(err instanceof ApiError ? err.hint : "Couldn't save", "error");

  const backendOn = canvas.backendEnabled;
  // A public_link canvas serves static files only — every primitive is refused for
  // public visitors (R17). Backend may still be on (it works for the owner/admins),
  // so warn rather than block: the combination is valid but surprising.
  const publicBackendInert = canvas.access === "public_link" && backendOn;

  if (!backendOn && !policyDirty)
    return (
      <TabContentFrame>
        <Section
          id="backend"
          title="This canvas is static"
          description="Pages, images and scripts work without a backend. Enable it when your canvas needs saved data, uploads, AI or live updates."
        >
          <Toggle
            label="Enable backend"
            checked={false}
            disabled={update.isPending || canvas.status === "disabled"}
            onChange={(next) => update.mutate({ backendEnabled: next }, { onError: onSaveError })}
          />
          <a href="/docs" className="text-sm text-accent hover:underline">
            SDK docs
          </a>
          <details className="space-y-4">
            <summary className="cursor-pointer text-sm text-accent">
              Review saved configuration
            </summary>
            <p className="text-sm text-muted">
              These preferences are retained while Backend is off. They take effect only after
              Backend and the relevant feature are enabled.
            </p>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {BACKEND_FEATURES.map((feature) => (
                <div key={feature.key}>
                  <dt className="font-medium">{feature.label}</dt>
                  <dd className="text-muted">
                    {canvas.capabilities[feature.key] ? "Saved as on" : "Saved as off"}
                  </dd>
                </div>
              ))}
            </dl>
            <RuntimePolicySettings
              canvas={canvas}
              save={(patch) => update.mutateAsync(patch)}
              pending={update.isPending}
              connectionKeys={connections.data?.map((connection) => connection.key) ?? []}
            />
          </details>
        </Section>
      </TabContentFrame>
    );

  return (
    <TabContentFrame>
      <Section
        id="backend"
        title="Backend"
        description="Choose the features this canvas can use, then who can use them."
      >
        <div className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs leading-relaxed text-muted">
          Canvas code can use enabled primitives without browser secrets. Read the{" "}
          <a href="/docs" className="font-medium text-accent hover:underline">
            SDK docs
          </a>{" "}
          for the client API.
        </div>
        {publicBackendInert && (
          <InlineNotice tone="warning" className="py-2 text-xs">
            This canvas is shared as a public link, which serves static files only. The backend
            primitives below run only for the canvas owner and editors. Public-link viewers have
            static access, except for a Connection grant explicitly opened to public visitors by an
            administrator.
          </InlineNotice>
        )}
        <Toggle
          label="Enable backend"
          description="Off by default. A canvas is static until you turn this on."
          checked={backendOn}
          disabled={(policyDirty && backendOn) || update.isPending || canvas.status === "disabled"}
          onChange={(next) => update.mutate({ backendEnabled: next }, { onError: onSaveError })}
        />
        {policyDirty && (
          <p className="text-sm text-warning">
            {backendOn
              ? "Save or discard permission changes before turning Backend off."
              : "Backend was turned off. Your pending permissions are still shown. Turn Backend on to save them, or discard your changes."}
          </p>
        )}
        <RowDivider />

        {BACKEND_FEATURES.map((f) => {
          const storedOn = canvas.capabilities[f.key];
          const gatedByOperator = backendOn && storedOn && !canvas.effective[f.key];
          const audience =
            f.key === "ai" ? "aiAudience" : f.key === "authoring" ? "authoringAudience" : null;
          return (
            <div
              key={f.key}
              className="space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0"
            >
              <Toggle
                label={f.label}
                description={
                  gatedByOperator ? (
                    <span className="text-warning">
                      Disabled by your administrator for this instance.
                    </span>
                  ) : (
                    f.description
                  )
                }
                checked={storedOn}
                disabled={!backendOn || update.isPending || canvas.status === "disabled"}
                onChange={(next) => update.mutate({ [f.key]: next }, { onError: onSaveError })}
              />
              {audience && (
                <label className="grid gap-1 text-sm text-muted sm:max-w-sm">
                  {f.key === "ai" ? "AI access" : "Authoring access"}
                  <select
                    aria-label={f.key === "ai" ? "AI access" : "Authoring access"}
                    value={canvas[audience] ?? (f.key === "authoring" ? "viewers" : "editors")}
                    disabled={update.isPending || canvas.status === "disabled"}
                    className="max-w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
                    onChange={(event) =>
                      update.mutate(
                        { [audience]: event.target.value as "editors" | "viewers" },
                        { onError: onSaveError },
                      )
                    }
                  >
                    <option value="editors">Owners and editors</option>
                    <option value="viewers">All signed-in viewers</option>
                  </select>
                  {f.key === "ai"
                    ? "Requests use this canvas's AI budget."
                    : "People create canvases as themselves, within their existing account permissions."}
                </label>
              )}
            </div>
          );
        })}
        <RowDivider />

        <Row
          title="Identity"
          description="Canvas code can read the signed-in viewer via me(). Always on when backend is enabled."
        >
          <span className="text-xs font-medium text-muted">{backendOn ? "Always on" : "Off"}</span>
        </Row>
      </Section>
      <Section
        id="connections"
        title="Connections"
        description="Third-party origins an administrator has granted to this canvas."
      >
        <label className="grid gap-1 text-sm text-muted sm:max-w-sm">
          Connection access
          <select
            aria-label="Connection access"
            value={canvas.connectionsAudience ?? "editors"}
            disabled={update.isPending || canvas.status === "disabled"}
            className="max-w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
            onChange={(event) =>
              update.mutate(
                { connectionsAudience: event.target.value as "editors" | "viewers" },
                { onError: onSaveError },
              )
            }
          >
            <option value="editors">Owners and editors</option>
            <option value="viewers">All signed-in viewers</option>
          </select>
          A resource policy may narrow this further. Administrator grants and methods always apply.
        </label>
        {connections.isLoading ? <p className="text-sm text-muted">Loading connections…</p> : null}
        {connections.isError ? (
          <ReadError
            title="Connection grants could not be loaded"
            onRetry={() => void connections.refetch()}
            retrying={connections.isFetching}
          />
        ) : null}
        {!connections.isError && connections.data?.length === 0 ? (
          <p className="text-sm text-muted">
            No outbound connections are granted. Ask an administrator to attach a connection profile
            if this canvas needs third-party data.
          </p>
        ) : null}
        {connections.data?.map((connection) => (
          <div
            key={connection.key}
            className="rounded-lg border border-border bg-surface-raised px-3 py-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-fg">{connection.label}</p>
                <p className="font-mono text-xs text-muted">{connection.key}</p>
              </div>
              <Badge tone={connection.available ? "success" : "warning"}>
                {connection.available ? "Available" : "Unavailable"}
              </Badge>
            </div>
            <p className="mt-2 break-all font-mono text-xs text-muted">{connection.origin}</p>
            <p className="mt-1 text-xs text-muted">
              Methods: {connection.allowedMethods.join(", ")}
            </p>
            {!connection.available ? (
              <p className="mt-2 text-xs text-warning">
                {connection.unavailableReason === "backend_off"
                  ? "Turn on Backend to use this grant."
                  : "An administrator must restore this connection profile."}
              </p>
            ) : null}
          </div>
        ))}
      </Section>
      <RuntimePolicySettings
        canvas={canvas}
        save={(patch) => update.mutateAsync(patch)}
        pending={update.isPending}
        connectionKeys={connections.data?.map((connection) => connection.key) ?? []}
        onDirtyChange={setPolicyDirty}
      />
      <PendingChangesGuard dirty={policyDirty} />
    </TabContentFrame>
  );
}
