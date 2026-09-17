import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatBytes } from "../lib/format.js";
import { useAdminAccessExplanation, useAdminInspection } from "../lib/queries.js";
import { type DataPolicy, PRESETS, RIGHT_LABELS } from "../lib/runtime-policy.js";

import { AdminActivityList } from "./AdminActivityList.js";
import { AccessBadge, Badge } from "./Badge.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import { Field } from "./Field.js";

function ResourcePolicyDetails({
  name,
  policy,
  files = false,
}: {
  name: string;
  policy: DataPolicy;
  files?: boolean;
}) {
  const rules = { ...PRESETS[policy.preset].rules, ...policy.overrides };
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer">
        {name}: {PRESETS[policy.preset].label}
        {policy.overrides ? " (custom operations)" : ""}
      </summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        {Object.entries(rules)
          .filter(([operation]) => !files || operation !== "increment")
          .map(([operation, right]) => (
            <div key={operation} className="contents">
              <dt className="capitalize">
                {files && operation === "update" ? "Rename" : operation}
              </dt>
              <dd>{RIGHT_LABELS[right]}</dd>
            </div>
          ))}
        {!files && (
          <>
            <dt>Total count</dt>
            <dd>{RIGHT_LABELS[policy.aggregateCount ?? "none"]}</dd>
          </>
        )}
      </dl>
    </details>
  );
}

function AccessCheck({ canvasId }: { canvasId: string }) {
  const [email, setEmail] = useState("");
  const [checked, setChecked] = useState<string | null>(null);
  const check = useAdminAccessExplanation(canvasId, checked || undefined, checked !== null);
  return (
    <section className="space-y-3" aria-label="Explain access">
      <h3 className="font-semibold text-fg">Explain access</h3>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = email.trim().toLowerCase();
          if (value === checked) void check.refetch();
          else setChecked(value);
        }}
      >
        <div className="min-w-0 flex-1">
          <Field
            type="email"
            label="Person's email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Leave blank for a signed-out visitor"
          />
        </div>
        <Button type="submit" size="sm" loading={check.isFetching}>
          Check access
        </Button>
      </form>
      {check.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not check access. Try again.
        </p>
      )}
      {check.data && (
        <div className="space-y-2 rounded-lg border border-border bg-surface p-3 text-sm">
          <p className="text-xs text-muted">
            {check.data.subject === "account"
              ? `Account: ${check.data.email}`
              : "Evaluated as a signed-out visitor"}{" "}
            · Checked {new Date(check.data.checkedAt).toLocaleTimeString()}
          </p>
          <Badge tone={check.data.result === "allowed" ? "success" : "warning"}>
            {check.data.result === "allowed"
              ? "Can view"
              : check.data.result === "password_required"
                ? "Password required"
                : "Cannot view"}
          </Badge>
          {check.data.managementRole !== "none" && (
            <p>Management role: {check.data.managementRole}</p>
          )}
          {check.data.staticOnly && (
            <p className="text-muted">Static content only; backend features are unavailable.</p>
          )}
          <ul className="list-disc space-y-1 pl-4 text-muted">
            {check.data.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function AdminCanvasInspector({
  canvasId,
  onClose,
}: {
  canvasId: string;
  onClose: () => void;
}) {
  const query = useAdminInspection(canvasId);
  const data = query.data;
  return (
    <Dialog
      placement="side"
      open
      onClose={onClose}
      title={data?.canvas.title || "Canvas inspector"}
      description="Administrative metadata. Content access follows the canvas's existing permissions."
    >
      <div className="space-y-6">
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => query.refetch()}
            loading={query.isFetching}
          >
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close inspector
          </Button>
        </div>
        {query.isLoading && <p role="status">Loading canvas details…</p>}
        {query.isError && (
          <p role="alert" className="text-danger">
            Could not load this canvas. It may no longer exist.
          </p>
        )}
        {data && (
          <>
            <section className="space-y-3" aria-label="Canvas metadata">
              <p className="break-all text-sm text-subtle">/{data.canvas.slug}</p>
              <div className="flex flex-wrap gap-2">
                <AccessBadge access={data.canvas.access} />
                <Badge tone="neutral">{data.canvas.publicationState}</Badge>
                <Badge tone={data.canvas.publicLinkEffective ? "success" : "neutral"}>
                  {data.canvas.publicLinkEffective
                    ? "Public link available"
                    : "Public link unavailable"}
                </Badge>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-subtle">Owner</dt>
                  <dd className="break-all">
                    {data.owner?.email ?? "Missing owner"}
                    {data.owner?.blocked ? " (blocked)" : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-subtle">Password</dt>
                  <dd>{data.canvas.hasPassword ? "Required for viewers" : "Not set"}</dd>
                </div>
                <div>
                  <dt className="text-subtle">Sharing expires</dt>
                  <dd>
                    {data.canvas.sharedExpiresAt === null
                      ? "No expiry"
                      : new Date(data.canvas.sharedExpiresAt).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-subtle">Backend</dt>
                  <dd>{data.canvas.backendEnabled ? "Enabled" : "Disabled"}</dd>
                </div>
              </dl>
              {data.canvas.disabledReason && (
                <p className="text-sm text-danger">Disabled: {data.canvas.disabledReason}</p>
              )}
            </section>
            <AccessCheck key={canvasId} canvasId={canvasId} />
            <section className="space-y-2" aria-label="Runtime permissions">
              <h3 className="font-semibold">Runtime permissions</h3>
              <p className="text-sm text-muted">
                Owners and editors manage shared content. Authored resources use their configured
                policies.
              </p>
              <p className="text-sm">
                AI: {RIGHT_LABELS[data.canvas.aiAudience ?? "editors"]}. Connections:{" "}
                {RIGHT_LABELS[data.canvas.connectionsAudience ?? "editors"]} unless a profile policy
                overrides it. Authoring: {RIGHT_LABELS[data.canvas.authoringAudience ?? "viewers"]}.
                Feature switches and administrator grants still apply.
              </p>
              {data.canvas.runtimePolicy && (
                <>
                  <p className="text-sm">
                    Default for new resources:{" "}
                    {data.canvas.runtimePolicy.defaultMode.replaceAll("_", " ")}
                  </p>
                  <div className="space-y-2 text-sm text-muted">
                    {Object.entries(data.canvas.runtimePolicy.collections).map(([name, policy]) => (
                      <ResourcePolicyDetails
                        key={`collection:${name}`}
                        name={`Collection ${name}`}
                        policy={policy}
                      />
                    ))}
                    {Object.entries(data.canvas.runtimePolicy.fileGroups).map(([name, policy]) => (
                      <ResourcePolicyDetails
                        key={`file:${name}`}
                        files
                        name={`File group ${name}`}
                        policy={policy}
                      />
                    ))}
                    {Object.entries(data.canvas.runtimePolicy.channels).map(([name, policy]) => (
                      <p key={`channel:${name}`}>
                        Channel {name}: receive — {RIGHT_LABELS[policy.subscribe]}; publish —{" "}
                        {RIGHT_LABELS[policy.publish]}; see presence —{" "}
                        {RIGHT_LABELS[policy.seePresence]}; appear in presence —{" "}
                        {RIGHT_LABELS[policy.participatePresence]}.
                      </p>
                    ))}
                    {Object.entries(data.canvas.runtimePolicy.connections).map(([name, policy]) => (
                      <p key={`connection:${name}`}>
                        Connection {name}: {RIGHT_LABELS[policy.audience]};{" "}
                        {policy.methods?.join(", ") ||
                          (policy.methods ? "no methods" : "administrator-approved methods")}
                        . Administrator grants still apply.
                      </p>
                    ))}
                  </div>
                </>
              )}
              <p className="text-sm text-muted">
                Policy changes belong to the canvas's Backend tab. Admin status does not grant
                permission to read private participant records.
              </p>
            </section>
            <section className="space-y-2" aria-label="People and teams">
              <h3 className="font-semibold">People and teams</h3>
              {!data.people.length && !data.teams.length && !data.pending.length && (
                <p className="text-sm text-muted">No additional grants or pending invitations.</p>
              )}
              <ul className="space-y-2 text-sm text-muted">
                {data.people.map((p) => (
                  <li key={`${p.userId}:${p.email}`}>
                    {p.email ?? p.userId} · {p.role}
                  </li>
                ))}
                {data.teams.map((team) => (
                  <li key={team.id}>
                    {team.name} · {team.role}
                  </li>
                ))}
                {data.pending.map((p) => (
                  <li key={p.id}>
                    {p.email} · pending {p.role ?? "viewer"} · {p.via}
                  </li>
                ))}
              </ul>
            </section>
            <section className="space-y-2" aria-label="Canvas usage">
              <h3 className="font-semibold">Usage</h3>
              <p className="text-sm text-muted">
                {data.usage.operations.toLocaleString()} recorded operations ·{" "}
                {data.usage.versionCount} versions · {formatBytes(data.usage.deployedBytes)}{" "}
                deployed · {formatBytes(data.usage.uploadedFileBytes)} uploaded files
              </p>
            </section>
            <section className="space-y-2" aria-label="Canvas connections">
              <h3 className="font-semibold">Connections</h3>
              {!data.connections.length ? (
                <p className="text-sm text-muted">No outbound connections granted.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {data.connections.map((connection) => (
                    <li key={connection.key}>
                      <span className="font-medium">{connection.label}</span> ·{" "}
                      {connection.available ? "Available" : "Unavailable"}
                      <p className="break-all text-xs text-muted">
                        {connection.origin} · {connection.allowedMethods.join(", ")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <Link className="text-sm text-accent hover:underline" to="/admin/connections">
                Manage connections
              </Link>
            </section>
            <section className="space-y-2" aria-label="Recent administrative changes">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold">Recent changes</h3>
                <Link
                  className="text-sm text-accent hover:underline"
                  to="/admin/activity"
                  search={{ canvasId }}
                >
                  All activity
                </Link>
              </div>
              <AdminActivityList events={data.activity.events} showTarget={false} />
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
