import { useEffect, useState } from "react";
import {
  type AllowlistEntry,
  ApiError,
  api,
  type Team,
  type TransferCandidate,
} from "../lib/api.js";
import { inputControl } from "../lib/input-styles.js";
import { addPersonFeedback } from "../lib/invite-feedback.js";
import { usePeopleSearch } from "../lib/queries.js";
import { ApiKeyReveal } from "./ApiKeyReveal.js";
import { Badge } from "./Badge.js";
import { Button } from "./Button.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { PeopleEmailCombobox } from "./PeopleEmailCombobox.js";
import { SegmentedControl } from "./SegmentedControl.js";
import { Skeleton } from "./Skeleton.js";
import { InlineNotice } from "./Surface.js";
import { useToast } from "./Toast.js";

export type AccessRole = "viewer" | "editor";

/** The scope label for a team: a PERSONAL team (no org) vs an org team (named by its org). */
export function TeamScopeBadge({
  team,
  orgs,
}: {
  team: Pick<Team, "orgId">;
  orgs: Array<{ id: string; name: string }>;
}) {
  if (team.orgId === null) return <Badge tone="neutral">Personal</Badge>;
  const orgName = orgs.find((o) => o.id === team.orgId)?.name;
  return <Badge tone="accent">{orgName ?? "Workspace"}</Badge>;
}

export interface PeopleAccessListProps {
  canvasId: string;
  /** The caller's role on the canvas — owner-only controls (Transfer) key off it (KTD14). */
  role: "owner" | "editor" | null | undefined;
  /** Teams the caller may grant (the ones they belong to). */
  teams: Team[];
  orgs: Array<{ id: string; name: string }>;
  /** Fires with the fresh list after every load/change (the share view mirrors it). */
  onChanged?: (entries: AllowlistEntry[]) => void;
  /** Owner-only: transfer ownership to the chosen editor. */
  onTransfer?: (toUserId: string) => Promise<void>;
  transferring?: boolean;
}

const ROLE_LABEL: Record<AccessRole, string> = { viewer: "Viewer", editor: "Editor" };
/** The two roles as a segmented choice — a real either/or, never a dropdown that reads as
 *  a button (share-tab UX fix). */
const ROLE_ITEMS = [
  { value: "viewer", label: ROLE_LABEL.viewer, title: "Can open the canvas" },
  { value: "editor", label: ROLE_LABEL.editor, title: "Manages the canvas with the owner" },
] as const;

function entryLabel(e: AllowlistEntry): string {
  if (e.kind === "team") return e.name ?? "Team";
  return e.email ?? e.name ?? "(unknown)";
}

/**
 * The unified people list (editor-roles plan, KD1/KTD5): the owner pinned first, then
 * people, pending invitees, and teams — each with a role control (viewer / editor; guests
 * are always viewers). One list, one add-a-person and one add-a-team control, so a
 * colleague or a whole team becomes an editor in a single grant. General access lives
 * below it, unchanged. The Transfer ownership action shows in the owner's view only.
 */
export function PeopleAccessList({
  canvasId,
  role,
  teams,
  orgs,
  onChanged,
  onTransfer,
  transferring = false,
}: PeopleAccessListProps) {
  const toast = useToast();
  const [entries, setEntries] = useState<AllowlistEntry[] | null>(null);
  const [email, setEmail] = useState("");
  const [personRole, setPersonRole] = useState<AccessRole>("viewer");
  const [teamId, setTeamId] = useState("");
  const [teamRole, setTeamRole] = useState<AccessRole>("viewer");
  // One flag per action (review #21): adding a person never greys out Add team.
  const [personBusy, setPersonBusy] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState<string | null>(null);
  // Owner-only, server-derived (review #7): every effective editor, including the people
  // behind an editor team — the list's team ROW can't be a transfer target.
  const [candidates, setCandidates] = useState<TransferCandidate[] | null>(null);
  // KTD11 / AE19: after an editor leaves (removed or demoted), offer to rotate the deploy
  // key they may have copied. Declining removes only the grant.
  const [keyPrompt, setKeyPrompt] = useState<string | null>(null);
  // Removal is confirmed first (it is destructive for the person on their next request).
  const [removing, setRemoving] = useState<AllowlistEntry | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const search = email.trim();
  const searchEnabled = search.length >= 2;
  const { data: suggestions = [], isFetching: searchingPeople } = usePeopleSearch(
    { context: "canvas", canvasId, q: search },
    searchEnabled,
  );

  const reload = () =>
    api
      .listAllowlist(canvasId)
      .then((view) => {
        setEntries(view.entries);
        setCandidates(view.transferCandidates ?? null);
        onChanged?.(view.entries);
      })
      .catch((err) => {
        // Surface the failure instead of silently showing an empty list — an
        // inaccessible list must be distinguishable from a real-empty one.
        toast(err instanceof ApiError ? err.hint : "Couldn't load the access list", "error");
        setEntries([]);
      });

  // biome-ignore lint/correctness/useExhaustiveDependencies: load on canvasId change only
  useEffect(() => {
    void reload();
  }, [canvasId]);

  const grantedTeamIds = new Set(
    (entries ?? []).filter((e) => e.kind === "team").map((e) => e.teamId),
  );
  const addableTeams = teams.filter((t) => !grantedTeamIds.has(t.id));
  // Transfer recipients: the server's projection when present (owners), else the direct
  // editor rows (legacy payloads) — never the team rows themselves.
  const editors: TransferCandidate[] =
    candidates ??
    (entries ?? [])
      .filter((e) => e.kind === "member" && e.role === "editor" && e.userId)
      .map((e) => ({ id: e.userId as string, name: e.name ?? "", email: e.email ?? "" }));
  const nonOwner = (entries ?? []).filter((e) => e.kind !== "owner");

  async function addPerson() {
    const value = email.trim();
    if (!value) return;
    setPersonBusy(true);
    try {
      const r = await api.addAllowlistMember(canvasId, value, personRole);
      setEmail("");
      await reload();
      if (r.status === "role_changed") toast("Role updated");
      else {
        const feedback = addPersonFeedback("canvas", r.status, r.emailDelivery);
        toast(feedback.message, feedback.tone);
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add that person", "error");
    } finally {
      setPersonBusy(false);
    }
  }

  async function addTeam() {
    if (!teamId) return;
    setTeamBusy(true);
    try {
      await api.addAllowlistTeam(canvasId, teamId, teamRole);
      setTeamId("");
      await reload();
      toast(teamRole === "editor" ? "Team added as editors" : "Team added");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add that team", "error");
    } finally {
      setTeamBusy(false);
    }
  }

  async function changeRole(e: AllowlistEntry, next: AccessRole) {
    try {
      await api.setAllowlistRole(canvasId, e.id, next);
      await reload();
      if (e.role === "editor" && next === "viewer") setKeyPrompt(entryLabel(e));
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't change the role", "error");
    }
  }

  async function remove(e: AllowlistEntry) {
    setRemoveBusy(true);
    try {
      await api.removeAllowlistEntry(canvasId, e.id);
      setRemoving(null);
      await reload();
      if (e.role === "editor") setKeyPrompt(entryLabel(e));
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't remove", "error");
    } finally {
      setRemoveBusy(false);
    }
  }

  async function regenerateKey() {
    setRegenerating(true);
    try {
      const { apiKey } = await api.regenerateKey(canvasId);
      setKeyPrompt(null);
      setRevealedKey(apiKey);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't regenerate the key", "error");
    } finally {
      setRegenerating(false);
    }
  }

  const roleSelect = (e: AllowlistEntry) => (
    <SegmentedControl
      aria-label={`Role for ${entryLabel(e)}`}
      size="sm"
      items={ROLE_ITEMS}
      value={e.role === "editor" ? "editor" : "viewer"}
      onChange={(next) => {
        if (next !== (e.role === "editor" ? "editor" : "viewer")) void changeRole(e, next);
      }}
    />
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Everyone listed here can open the canvas, whatever General access below says. An
        <strong className="font-medium text-fg"> editor</strong> also runs it with you — content,
        settings, sharing — everything except deleting or transferring it. Only org members and
        teams can be editors.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <PeopleEmailCombobox
            label="Person's email"
            placeholder="colleague@example.com"
            value={email}
            onChange={setEmail}
            onSubmit={() => void addPerson()}
            suggestions={suggestions}
            searchEnabled={searchEnabled}
            searching={searchingPeople}
          />
        </div>
        <SegmentedControl
          aria-label="Role for the person to add"
          items={ROLE_ITEMS}
          value={personRole}
          onChange={setPersonRole}
        />
        <Button
          size="sm"
          variant="secondary"
          loading={personBusy}
          disabled={!email.trim()}
          onClick={() => void addPerson()}
        >
          Add person
        </Button>
      </div>

      {teams.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1.5 text-sm font-medium text-fg">
            Team
            <select
              aria-label="Team to add"
              className={`${inputControl} h-9 py-0`}
              value={teamId}
              onChange={(ev) => setTeamId(ev.target.value)}
            >
              <option value="">Choose a team…</option>
              {addableTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.orgId === null ? " (personal)" : ""}
                </option>
              ))}
            </select>
          </label>
          <SegmentedControl
            aria-label="Role for the team to add"
            items={ROLE_ITEMS}
            value={teamRole}
            onChange={setTeamRole}
          />
          <Button
            size="sm"
            variant="secondary"
            loading={teamBusy}
            disabled={!teamId}
            onClick={() => void addTeam()}
          >
            Add team
          </Button>
        </div>
      ) : null}

      {entries === null ? (
        <Skeleton className="h-8" />
      ) : (
        <ul className="divide-y divide-border" aria-label="People and teams">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-fg">{entryLabel(e)}</span>
                {e.kind === "owner" && <Badge tone="accent">Owner</Badge>}
                {e.kind === "team" && (
                  <TeamScopeBadge
                    team={{
                      orgId: e.teamOrgId ?? teams.find((t) => t.id === e.teamId)?.orgId ?? null,
                    }}
                    orgs={orgs}
                  />
                )}
                {e.kind === "team" && <span className="text-xs text-muted">team</span>}
                {e.kind === "pending" && (
                  <span className="text-xs text-muted">pending sign-in</span>
                )}
                {e.kind === "guest" && <span className="text-xs text-muted">legacy guest</span>}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {e.kind === "owner" ? null : e.kind === "guest" ? (
                  <span
                    className="text-xs text-muted"
                    title="Guests can only view — only org members can be editors."
                  >
                    {ROLE_LABEL.viewer}
                  </span>
                ) : (
                  roleSelect(e)
                )}
                {e.kind !== "owner" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted hover:text-danger"
                    onClick={() => setRemoving(e)}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {entries !== null && nonOwner.length === 0 && (
        <p className="text-xs text-muted">No one added yet. Only you can open this.</p>
      )}

      {role !== "editor" && onTransfer && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">Transfer ownership</p>
            <p className="text-xs text-muted">
              Hand this canvas to one of its editors. It takes effect at once; you stay on as an
              editor.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={editors.length === 0}
            title={
              editors.length === 0
                ? "Add an editor first — ownership can only move to an editor."
                : undefined
            }
            onClick={() => {
              setTransferTo(editors[0]?.id ?? null);
              setTransferOpen(true);
            }}
          >
            Transfer ownership
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
        title={removing ? `Remove ${entryLabel(removing)}?` : "Remove?"}
        actionLabel="Remove"
        destructive
        loading={removeBusy}
      >
        {removing?.kind === "team"
          ? "The team's members lose the access this grant gave them on their next request. Their own grants, if any, stay."
          : removing?.kind === "pending"
            ? "The pending invite is cancelled; they get nothing when they sign in."
            : "They lose access on their next request. Nothing they saved changes."}
      </ConfirmDialog>

      <ConfirmDialog
        open={keyPrompt !== null}
        onClose={() => setKeyPrompt(null)}
        onConfirm={() => void regenerateKey()}
        title="Regenerate the deploy key?"
        actionLabel="Regenerate key"
        loading={regenerating}
      >
        {keyPrompt} no longer edits this canvas, but a deploy key they copied keeps working.
        Regenerating invalidates the current key at once; the new key is shown once. Declining
        leaves the key as it is.
      </ConfirmDialog>
      {revealedKey && (
        <ApiKeyReveal
          apiKey={revealedKey}
          onClose={() => setRevealedKey(null)}
          notice={{
            title: "Update your deploy scripts",
            description:
              "Anything still using the old key stops deploying now — give the new key to the people and agents who deploy this canvas.",
          }}
        />
      )}

      <ConfirmDialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="Transfer ownership?"
        actionLabel="Transfer ownership"
        destructive
        loading={transferring}
        onConfirm={() => {
          if (!transferTo || !onTransfer) return;
          // The owner row and the recipient's row both change hands: re-read the list
          // once the transfer has applied so it never shows the pre-transfer roles.
          void onTransfer(transferTo)
            .then(async () => {
              setTransferOpen(false);
              await reload();
            })
            // The caller already toasts the failure; the dialog stays open for a retry.
            .catch(() => {});
        }}
      >
        <div className="space-y-3">
          <p>
            The person you pick becomes the owner immediately — sharing, the public-link
            entitlement, and the deploy key follow their account. You keep editor access.
          </p>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-fg">New owner</legend>
            {editors.map((e) => (
              <label
                key={e.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-hover"
              >
                <input
                  type="radio"
                  name="transfer-to"
                  checked={transferTo === e.id}
                  onChange={() => setTransferTo(e.id)}
                />
                <span className="text-sm text-fg">{e.name || e.email}</span>
                {e.name && e.email && <span className="text-xs text-muted">{e.email}</span>}
              </label>
            ))}
          </fieldset>
          {editors.length === 0 && (
            <InlineNotice tone="neutral" className="py-2 text-xs">
              Add an editor first — ownership can only move to an existing editor.
            </InlineNotice>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
