import { useParams } from "@tanstack/react-router";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { Row, RowDivider, Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice } from "../components/Surface.js";
import { Toggle } from "../components/Toggle.js";
import type { FeatureCapability } from "../lib/api.js";
import { useUpdateCapabilities } from "../lib/mutations.js";
import { useCanvas } from "../lib/queries.js";

/**
 * Backend-group features (plan 006). Mirrors the shared capability taxonomy — the
 * dashboard bundle is intentionally free of workspace `shared` imports, so the
 * labels live here; the server is authoritative for stored + effective state.
 */
const BACKEND_FEATURES: { key: FeatureCapability; label: string; description: string }[] = [
  {
    key: "kv",
    label: "Key-value storage",
    description: "Per-canvas and per-user durable state.",
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
];

/**
 * Capabilities tab (plan 006). One "Backend" group: a master switch plus the four
 * backend features. Feature toggles are disabled while backend is off; a feature
 * the operator has globally disabled shows a hint. Identity (`me()`) is always on
 * when backend is enabled. Toggles are optimistic (useUpdateCapabilities).
 */
export default function Capabilities() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: canvas, isLoading } = useCanvas(id);
  const update = useUpdateCapabilities(id);

  if (isLoading || !canvas) {
    return <Skeleton className="h-64" />;
  }

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
            primitives below won't run for public visitors — only for you and signed-in org members.
          </InlineNotice>
        )}
        <Toggle
          label="Enable backend"
          description="Off by default. A canvas is static until you turn this on."
          checked={backendOn}
          onChange={(next) => update.mutate({ backendEnabled: next })}
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
              onChange={(next) => update.mutate({ [f.key]: next })}
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
    </TabContentFrame>
  );
}
