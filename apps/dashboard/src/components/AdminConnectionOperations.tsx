import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { type AdminConnection, ApiError, api } from "../lib/api.js";
import { useAdminConnectionHealth } from "../lib/queries.js";
import { Badge } from "./Badge.js";
import { Button } from "./Button.js";
import { Field } from "./Field.js";
import { InlineNotice, MetaGrid, MetaItem } from "./Surface.js";

const diagnosticHints: Record<string, string> = {
  success:
    "The upstream accepted this HEAD request. Check a granted canvas to verify its full workflow.",
  upstream_status:
    "The upstream responded with a non-success status. Check the endpoint, credential permissions, and whether it supports HEAD.",
  destination_blocked:
    "The destination failed the outbound address policy. Check the approved public HTTPS origin and DNS.",
  upstream_timeout:
    "The upstream did not finish within five seconds. Check its availability and network path.",
  upstream_unavailable:
    "The upstream could not be reached. Check DNS, TLS, and service availability.",
};

export function AdminConnectionHealthSummary({ profile }: { profile: AdminConnection }) {
  const health = useAdminConnectionHealth();
  if (health.isLoading) return <p className="text-xs text-muted">Loading observed health…</p>;
  if (health.isError)
    return (
      <InlineNotice tone="warning">
        Observed health is unavailable.{" "}
        <Button size="sm" variant="ghost" onClick={() => void health.refetch()}>
          Retry health
        </Button>
      </InlineNotice>
    );
  const row = health.data?.profiles.find((item) => item.profileId === profile.id);
  const label = !profile.enabled
    ? "Paused"
    : !row?.requests
      ? "No recent traffic"
      : row.failures
        ? "Failures observed"
        : "Recent requests succeeded";
  const time = (value: number | null | undefined) =>
    value ? new Date(value).toLocaleString() : "None in this window";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={row?.failures ? "warning" : "neutral"}>{label}</Badge>
        <span className="text-xs text-muted">
          Observed canvas traffic · last 24 hours · not a live availability guarantee
        </span>
      </div>
      {row ? (
        <MetaGrid>
          <MetaItem label="Successful / failed">
            {row.successes} / {row.failures}
          </MetaItem>
          <MetaItem label="Average latency">
            {row.averageDurationMs === null ? "Unavailable" : `${row.averageDurationMs} ms`}
          </MetaItem>
          <MetaItem label="Last success">{time(row.lastSuccessAt)}</MetaItem>
          <MetaItem label="Last failure">{time(row.lastFailureAt)}</MetaItem>
          <MetaItem label="Canvases with failures">{row.affectedCanvasCount}</MetaItem>
        </MetaGrid>
      ) : null}
    </div>
  );
}

export function AdminConnectionDiagnostics({ profile }: { profile: AdminConnection }) {
  const [path, setPath] = useState("/");
  const diagnostic = useMutation({
    mutationFn: () => api.admin.diagnoseConnection(profile.id, path),
  });
  const available =
    profile.enabled &&
    profile.allowedMethods.includes("HEAD") &&
    (profile.encryptionKeyAvailable || !profile.protectedHeaders.length);
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-fg">Connection diagnostic</h3>
      <p className="text-xs text-muted">
        Sends one HEAD request to the approved origin with its protected headers. Five-second limit;
        no redirects. Response content is discarded. This does not test a canvas's access or count
        as canvas traffic.
      </p>
      {!available ? (
        <p className="text-xs text-muted">
          Enable the profile, allow HEAD, and configure available credentials to run a diagnostic.
        </p>
      ) : null}
      <Field
        label="Diagnostic path"
        value={path}
        onChange={(event) => {
          setPath(event.target.value);
          diagnostic.reset();
        }}
        placeholder="/health"
        description="Use an endpoint on this origin that supports HEAD. Paths and queries are not recorded in activity."
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={!available || !path.startsWith("/")}
        loading={diagnostic.isPending}
        onClick={() => diagnostic.mutate()}
      >
        Run HEAD diagnostic
      </Button>
      {diagnostic.error ? (
        <InlineNotice tone="warning">
          {diagnostic.error instanceof ApiError
            ? diagnostic.error.hint
            : "The diagnostic could not run."}
        </InlineNotice>
      ) : null}
      {diagnostic.data ? (
        <InlineNotice tone={diagnostic.data.outcome === "success" ? "success" : "warning"}>
          <p>
            {diagnostic.data.upstreamStatus ? `HTTP ${diagnostic.data.upstreamStatus} · ` : ""}
            {diagnostic.data.durationMs} ms ·{" "}
            {new Date(diagnostic.data.checkedAt).toLocaleTimeString()}
          </p>
          <p>
            {diagnosticHints[diagnostic.data.outcome] ??
              "The diagnostic could not complete within the connection's restrictions. Review the origin, methods, and upstream availability."}
          </p>
        </InlineNotice>
      ) : null}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-fg">
          Rotate protected credentials
        </summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-xs text-muted">
          <li>
            Create a replacement credential at the upstream with the required minimum permissions.
          </li>
          <li>
            Review the granted canvases below. Edit this profile and replace the complete
            protected-header set, including any headers you want to keep.
          </li>
          <li>
            Save, then check an appropriate endpoint and a granted canvas's real workflow. A
            successful HEAD request alone may not verify authentication.
          </li>
          <li>
            After verification, revoke the old credential at the upstream. To recover, replace the
            headers again with a still-valid credential; old values cannot be read back here.
          </li>
        </ol>
      </details>
    </div>
  );
}
