import { useState } from "react";
import { AdminHeader } from "../components/AdminHeader.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { EmptyState } from "../components/EmptyState.js";
import { Field } from "../components/Field.js";
import { InlineNotice, MetaGrid, MetaItem, Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import {
  type AdminConnection,
  ApiError,
  type ConnectionMethod,
  type ConnectionProfileInput,
} from "../lib/api.js";
import { inputControl } from "../lib/input-styles.js";
import {
  useAttachConnection,
  useCreateConnection,
  useDeleteConnection,
  useDetachConnection,
  useUpdateConnection,
} from "../lib/mutations.js";
import {
  useAdminCanvasConnections,
  useAdminCanvases,
  useAdminConnectionCanvases,
  useAdminConnectionEvents,
  useAdminConnections,
} from "../lib/queries.js";

const METHODS: ConnectionMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
type HeaderDraft = { id: string; name: string; value: string };
type ProfileDraft = {
  key: string;
  label: string;
  origin: string;
  allowedMethods: ConnectionMethod[];
  headers: HeaderDraft[];
};

const EMPTY_DRAFT: ProfileDraft = {
  key: "",
  label: "",
  origin: "",
  allowedMethods: ["GET"],
  headers: [],
};
let nextHeaderDraftId = 0;
function newHeaderDraft(): HeaderDraft {
  nextHeaderDraftId += 1;
  return { id: `header-${nextHeaderDraftId}`, name: "", value: "" };
}

function errorHint(error: unknown): string {
  return error instanceof ApiError ? error.hint : "The connection change could not be saved.";
}

function ProfileFields({
  draft,
  onChange,
  keyLocked = false,
  showHeaders = true,
}: {
  draft: ProfileDraft;
  onChange: (draft: ProfileDraft) => void;
  keyLocked?: boolean;
  showHeaders?: boolean;
}) {
  const toggleMethod = (method: ConnectionMethod) => {
    const selected = draft.allowedMethods.includes(method);
    onChange({
      ...draft,
      allowedMethods: selected
        ? draft.allowedMethods.filter((candidate) => candidate !== method)
        : [...draft.allowedMethods, method],
    });
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Profile key"
          value={draft.key}
          disabled={keyLocked}
          mono
          placeholder="stock-data"
          onChange={(event) => onChange({ ...draft, key: event.target.value })}
          description="Immutable URL-safe name used by canvas code. Lowercase letters, numbers, hyphens, and underscores."
        />
        <Field
          label="Display name"
          value={draft.label}
          placeholder="Stock data"
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
        />
      </div>
      <Field
        label="Exact HTTPS origin"
        value={draft.origin}
        mono
        placeholder="https://api.example.com"
        onChange={(event) => onChange({ ...draft, origin: event.target.value })}
        description="Scheme, host, and optional port only. Requests cannot redirect to another origin."
      />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg">Allowed methods</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {METHODS.map((method) => (
            <label key={method} className="inline-flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={draft.allowedMethods.includes(method)}
                onChange={() => toggleMethod(method)}
              />
              {method}
            </label>
          ))}
        </div>
      </fieldset>
      {showHeaders ? (
        <fieldset className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <legend className="text-sm font-medium text-fg">Protected headers</legend>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onChange({ ...draft, headers: [...draft.headers, newHeaderDraft()] })}
            >
              Add header
            </Button>
          </div>
          {draft.headers.length === 0 ? (
            <p className="text-xs text-muted">None. Values are write-only and encrypted at rest.</p>
          ) : (
            draft.headers.map((header, index) => (
              <div key={header.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input
                  aria-label={`Header ${index + 1} name`}
                  className={inputControl}
                  placeholder="User-Agent"
                  value={header.name}
                  onChange={(event) => {
                    const headers = draft.headers.slice();
                    headers[index] = { ...header, name: event.target.value };
                    onChange({ ...draft, headers });
                  }}
                />
                <input
                  aria-label={`Header ${index + 1} value`}
                  className={inputControl}
                  type="password"
                  autoComplete="new-password"
                  placeholder="Write-only value"
                  value={header.value}
                  onChange={(event) => {
                    const headers = draft.headers.slice();
                    headers[index] = { ...header, value: event.target.value };
                    onChange({ ...draft, headers });
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange({
                      ...draft,
                      headers: draft.headers.filter((_, candidate) => candidate !== index),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ))
          )}
        </fieldset>
      ) : null}
    </div>
  );
}

function CreateProfile() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const create = useCreateConnection();
  const toast = useToast();

  async function submit() {
    if (draft.allowedMethods.length === 0) {
      toast("Choose at least one method", "error");
      return;
    }
    try {
      await create.mutateAsync({
        key: draft.key,
        label: draft.label,
        origin: draft.origin,
        allowedMethods: draft.allowedMethods,
        protectedHeaders: draft.headers.map(({ name, value }) => ({ name, value })),
      });
      setDraft(EMPTY_DRAFT);
      setOpen(false);
      toast("Connection profile created");
    } catch (error) {
      toast(errorHint(error), "error");
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="self-start">
        New connection
      </Button>
    );
  }
  return (
    <Panel className="space-y-5">
      <div>
        <h2 className="font-display text-h2 text-fg">New connection</h2>
        <p className="text-sm text-muted">
          Approve one exact upstream origin for selected canvases.
        </p>
      </div>
      <ProfileFields draft={draft} onChange={setDraft} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={create.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={create.isPending}>
          Create connection
        </Button>
      </div>
    </Panel>
  );
}

function GrantEditor({ profile }: { profile: AdminConnection }) {
  const [search, setSearch] = useState("");
  const { data: page, isLoading } = useAdminCanvases({ q: search || undefined, limit: 10 });
  const { data: attached = [] } = useAdminConnectionCanvases(profile.id);
  const attach = useAttachConnection();
  const detach = useDetachConnection();
  const toast = useToast();
  const attachedIds = new Set(attached.map((canvas) => canvas.id));

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-fg">Granted canvases</h3>
      {attached.length === 0 ? (
        <p className="text-xs text-muted">No canvases can use this connection.</p>
      ) : (
        <ul className="space-y-2">
          {attached.map((canvas) => (
            <li key={canvas.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {canvas.title} <span className="font-mono text-xs text-muted">/{canvas.slug}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={detach.isPending && detach.variables?.canvasId === canvas.id}
                onClick={async () => {
                  try {
                    await detach.mutateAsync({ id: profile.id, canvasId: canvas.id });
                    toast(`Revoked ${profile.label} from ${canvas.title}`);
                  } catch (error) {
                    toast(errorHint(error), "error");
                  }
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Field
        label="Find a canvas to grant"
        value={search}
        placeholder="Search title, slug, or owner"
        onChange={(event) => setSearch(event.target.value)}
      />
      {isLoading ? <p className="text-xs text-muted">Finding canvases…</p> : null}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {(page?.canvases ?? []).map((canvas) => {
          const granted = attachedIds.has(canvas.id);
          return (
            <li
              key={canvas.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate">
                {canvas.title} <span className="font-mono text-xs text-muted">/{canvas.slug}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={granted}
                loading={attach.isPending && attach.variables?.canvasId === canvas.id}
                onClick={async () => {
                  try {
                    await attach.mutateAsync({ id: profile.id, canvasId: canvas.id });
                    toast(`Granted ${profile.label} to ${canvas.title}`);
                  } catch (error) {
                    toast(errorHint(error), "error");
                  }
                }}
              >
                {granted ? "Granted" : "Grant"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RecentEvents({ profileId }: { profileId: string }) {
  const [offset, setOffset] = useState(0);
  const { data, isLoading } = useAdminConnectionEvents(profileId, offset);
  if (isLoading) return <p className="text-xs text-muted">Loading recent outcomes…</p>;
  const events = data?.events ?? [];
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-fg">Recent outcomes</h3>
      <p className="text-xs text-muted">Sanitized request results retained for up to 90 days.</p>
      {events.length === 0 ? (
        <p className="text-xs text-muted">No requests in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-subtle">
              <tr>
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">Canvas</th>
                <th className="py-2 pr-3">Origin</th>
                <th className="py-2 pr-3">Method</th>
                <th className="py-2 pr-3">Outcome</th>
                <th className="py-2 pr-3">Bytes</th>
                <th className="py-2">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {new Date(event.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 font-mono">{event.canvasId}</td>
                  <td className="py-2 pr-3 font-mono">{event.origin ?? "—"}</td>
                  <td className="py-2 pr-3">{event.method ?? "—"}</td>
                  <td className="py-2 pr-3">{event.outcome ?? "—"}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {event.requestBytes ?? 0} → {event.responseBytes ?? 0}
                  </td>
                  <td className="py-2">
                    {event.durationMs === null ? "—" : `${event.durationMs} ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 25))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={events.length < 25}
          onClick={() => setOffset(offset + 25)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function ProfileCard({ profile }: { profile: AdminConnection }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [replaceHeaders, setReplaceHeaders] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>({
    key: profile.key,
    label: profile.label,
    origin: profile.origin,
    allowedMethods: profile.allowedMethods,
    headers: [],
  });
  const [pendingUpdate, setPendingUpdate] = useState<Omit<
    Partial<ConnectionProfileInput>,
    "key"
  > | null>(null);
  const [deleting, setDeleting] = useState(false);
  const update = useUpdateConnection();
  const remove = useDeleteConnection();
  const toast = useToast();

  const save = () => {
    if (draft.allowedMethods.length === 0) {
      toast("Choose at least one method", "error");
      return;
    }
    const input: Omit<Partial<ConnectionProfileInput>, "key"> = {
      label: draft.label,
      origin: draft.origin,
      allowedMethods: draft.allowedMethods,
    };
    if (replaceHeaders) {
      input.protectedHeaders = draft.headers.map(({ name, value }) => ({ name, value }));
    }
    if (
      profile.affectedCanvasCount > 0 ||
      (replaceHeaders && draft.headers.length === 0 && profile.protectedHeaders.length > 0)
    ) {
      setPendingUpdate(input);
    } else void applyUpdate(input);
  };

  async function applyUpdate(input: Omit<Partial<ConnectionProfileInput>, "key">) {
    try {
      const saved = await update.mutateAsync({ id: profile.id, input });
      setPendingUpdate(null);
      setReplaceHeaders(false);
      setDraft({
        key: saved.key,
        label: saved.label,
        origin: saved.origin,
        allowedMethods: saved.allowedMethods,
        headers: [],
      });
      setEditing(false);
      toast("Connection profile updated");
    } catch (error) {
      toast(errorHint(error), "error");
    }
  }

  async function toggleEnabled() {
    const input = { enabled: !profile.enabled };
    if (profile.affectedCanvasCount > 0) setPendingUpdate(input);
    else await applyUpdate(input);
  }

  return (
    <Panel className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-h2 text-fg">{profile.label}</h2>
            <Badge tone={profile.enabled ? "success" : "warning"}>
              {profile.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <p className="font-mono text-xs text-muted">
            canvasdrop.connections.fetch(&quot;{profile.key}&quot;, …)
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide details" : "Manage"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(!editing)}>
            {editing ? "Cancel edit" : "Edit"}
          </Button>
          <Button size="sm" variant="secondary" onClick={toggleEnabled}>
            {profile.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      </div>
      <MetaGrid>
        <MetaItem label="Exact origin">
          <span className="font-mono break-all">{profile.origin}</span>
        </MetaItem>
        <MetaItem label="Methods">{profile.allowedMethods.join(", ")}</MetaItem>
        <MetaItem label="Protected headers">
          {profile.protectedHeaders.length === 0
            ? "None"
            : profile.protectedHeaders.map((header) => `${header.name} configured`).join(", ")}
        </MetaItem>
        <MetaItem label="Blast radius">
          {profile.affectedCanvasCount} canvas{profile.affectedCanvasCount === 1 ? "" : "es"}
        </MetaItem>
      </MetaGrid>
      {!profile.encryptionKeyAvailable && profile.protectedHeaders.length > 0 ? (
        <InlineNotice tone="danger">
          The encryption key is unavailable. Requests fail closed until the key is restored or these
          protected headers are replaced.
        </InlineNotice>
      ) : null}
      {editing ? (
        <div className="space-y-4 border-t border-border pt-4">
          <ProfileFields draft={draft} onChange={setDraft} keyLocked showHeaders={replaceHeaders} />
          {!replaceHeaders ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">
                Protected values are preserved because they are not loaded into this form.
              </p>
              <Button size="sm" variant="secondary" onClick={() => setReplaceHeaders(true)}>
                Replace or clear protected headers
              </Button>
            </div>
          ) : (
            <InlineNotice tone="warning">
              Saving replaces the complete protected-header set. An empty list clears it.
            </InlineNotice>
          )}
          <div className="flex justify-end">
            <Button onClick={save} loading={update.isPending}>
              Save changes
            </Button>
          </div>
        </div>
      ) : null}
      {expanded ? (
        <>
          <GrantEditor profile={profile} />
          <RecentEvents profileId={profile.id} />
        </>
      ) : null}
      <ConfirmDialog
        open={pendingUpdate !== null}
        onClose={() => setPendingUpdate(null)}
        onConfirm={() => pendingUpdate && void applyUpdate(pendingUpdate)}
        title={`${profile.enabled && pendingUpdate?.enabled === false ? "Disable" : "Update"} ${profile.label}?`}
        actionLabel={
          profile.enabled && pendingUpdate?.enabled === false
            ? "Disable connection"
            : "Update connection"
        }
        destructive={profile.enabled && pendingUpdate?.enabled === false}
        loading={update.isPending}
      >
        {pendingUpdate?.protectedHeaders?.length === 0 && profile.protectedHeaders.length > 0
          ? "This clears every configured protected header. The existing values cannot be recovered."
          : `This takes effect immediately for ${profile.affectedCanvasCount} granted canvas${profile.affectedCanvasCount === 1 ? "" : "es"}.`}
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          try {
            await remove.mutateAsync({
              id: profile.id,
              affectedCanvasCount: profile.affectedCanvasCount,
            });
            setDeleting(false);
            toast(
              `Deleted ${profile.label} and revoked ${profile.affectedCanvasCount} grant${profile.affectedCanvasCount === 1 ? "" : "s"}`,
            );
          } catch (error) {
            toast(errorHint(error), "error");
          }
        }}
        title={`Delete ${profile.label}?`}
        actionLabel="Delete connection"
        destructive
        loading={remove.isPending}
      >
        This atomically revokes access from {profile.affectedCanvasCount} canvas
        {profile.affectedCanvasCount === 1 ? "" : "es"}. This cannot be undone.
      </ConfirmDialog>
    </Panel>
  );
}

function CanvasAuthorityInspector() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ id: string; title: string; slug: string } | null>(
    null,
  );
  const { data: page } = useAdminCanvases({ q: search || undefined, limit: 10 });
  const { data: connections = [], isLoading } = useAdminCanvasConnections(
    selected?.id ?? "",
    !!selected,
  );
  return (
    <Panel className="space-y-4">
      <div>
        <h2 className="font-display text-h2 text-fg">Inspect by canvas</h2>
        <p className="text-sm text-muted">
          See the complete outbound authority granted to one canvas.
        </p>
      </div>
      <Field
        label="Find canvas"
        value={search}
        placeholder="Search title, slug, or owner"
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {(page?.canvases ?? []).map((canvas) => (
          <Button
            key={canvas.id}
            size="sm"
            variant={selected?.id === canvas.id ? "primary" : "secondary"}
            onClick={() => setSelected(canvas)}
          >
            {canvas.title} /{canvas.slug}
          </Button>
        ))}
      </div>
      {selected ? (
        isLoading ? (
          <p className="text-sm text-muted">Loading authority…</p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted">{selected.title} has no connection grants.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {connections.map((connection) => (
              <li key={connection.key} className="px-3 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-fg">{connection.label}</span>
                  <Badge tone={connection.available ? "success" : "warning"}>
                    {connection.available ? "Available" : "Unavailable"}
                  </Badge>
                </div>
                <p className="font-mono text-xs text-muted">
                  {connection.origin} · {connection.allowedMethods.join(", ")}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Panel>
  );
}

export default function AdminConnections() {
  const { data: profiles, isLoading, isError } = useAdminConnections();
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <AdminHeader
        title="Connections"
        description="Approve exact third-party origins and grant them to individual canvases."
      />
      <InlineNotice tone="warning">
        Protected headers stay server-side and are applied after canvas headers. The approved
        upstream is trusted: it can reflect a protected value in its own response. Use the narrowest
        upstream credential and methods possible.
      </InlineNotice>
      <CreateProfile />
      {isLoading ? (
        <Panel>
          <p className="text-sm text-muted">Loading connections…</p>
        </Panel>
      ) : null}
      {isError ? <InlineNotice tone="danger">Connections could not be loaded.</InlineNotice> : null}
      {!isLoading && !isError && profiles?.length === 0 ? (
        <EmptyState
          title="No connections"
          description="Create a profile to let selected canvases call one approved HTTPS origin."
        />
      ) : null}
      <div className="space-y-4">
        {profiles?.map((profile) => (
          <ProfileCard key={profile.id} profile={profile} />
        ))}
      </div>
      <CanvasAuthorityInspector />
    </div>
  );
}
