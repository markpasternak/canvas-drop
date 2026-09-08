import { useParams } from "@tanstack/react-router";
import { Badge } from "../components/Badge.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
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
    description: "Server-side LLM proxy (no provider keys in the browser).",
  },
  {
    key: "realtime",
    label: "Realtime",
    description: "Ephemeral pub/sub + presence over WebSockets.",
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
  const toast = useToast();
  const { data: canvas, isLoading } = useCanvas(id);
  const connections = useCanvasConnections(id);
  const update = useUpdateCapabilities(id);

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

  return (
    <TabContentFrame>
      <Section
        id="backend"
        title="Backend"
        description="Give this canvas server-side primitives. You can change these any time."
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
            static access.
          </InlineNotice>
        )}
        <Toggle
          label="Enable backend"
          description="Off by default. A canvas is static until you turn this on."
          checked={backendOn}
          onChange={(next) => update.mutate({ backendEnabled: next }, { onError: onSaveError })}
        />
        <RowDivider />

        {BACKEND_FEATURES.map((f) => {
          const storedOn = canvas.capabilities[f.key];
          const gatedByOperator = backendOn && storedOn && !canvas.effective[f.key];
          return (
            <Toggle
              key={f.key}
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
              disabled={!backendOn}
              onChange={(next) => update.mutate({ [f.key]: next }, { onError: onSaveError })}
            />
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
        id="runtime-permissions"
        title="Who can use the backend"
        description="Viewers can read shared content, save private preferences, and submit their own responses. Only owners and editors can change shared content or review everyone's submissions."
      >
        {(
          [
            {
              key: "aiAudience",
              title: "AI access",
              description: "AI requests use the canvas's budget.",
            },
            {
              key: "connectionsAudience",
              title: "Connection access",
              description:
                "Connections can send requests and trigger actions in external services. Admin grants and allowed methods still apply.",
            },
          ] as const
        ).map((setting) => (
          <Row key={setting.key} title={setting.title} description={setting.description}>
            <select
              aria-label={setting.title}
              value={canvas[setting.key] ?? "editors"}
              disabled={!backendOn || update.isPending || canvas.status === "disabled"}
              className="max-w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
              onChange={(event) =>
                update.mutate(
                  { [setting.key]: event.target.value as "editors" | "viewers" },
                  { onError: onSaveError },
                )
              }
            >
              <option value="editors">Owners and editors</option>
              <option value="viewers">All signed-in viewers</option>
            </select>
          </Row>
        ))}
        <p className="text-xs text-muted">
          Private file submissions are visible to their uploader and the canvas's owners and
          editors. Public visitors have no backend access.
        </p>
      </Section>
      <Section
        id="connections"
        title="Connections"
        description="Third-party origins an administrator has granted to this canvas."
      >
        {connections.isLoading ? <p className="text-sm text-muted">Loading connections…</p> : null}
        {connections.isError ? (
          <InlineNotice tone="danger">Connection grants could not be loaded.</InlineNotice>
        ) : null}
        {connections.data?.length === 0 ? (
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
    </TabContentFrame>
  );
}
