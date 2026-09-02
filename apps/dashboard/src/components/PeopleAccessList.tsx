import { useEffect, useId, useRef, useState } from "react";
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
import { ActionMenu, ActionMenuItem } from "./ActionMenu.js";
import { ApiKeyReveal } from "./ApiKeyReveal.js";
import { Badge } from "./Badge.js";
import { Button } from "./Button.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { PeopleEmailCombobox } from "./PeopleEmailCombobox.js";
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
  /** Teams the caller may grant (the ones they belong to). */
  teams: Team[];
  orgs: Array<{ id: string; name: string }>;
  /** Fires with the fresh list after every load/change (the share view mirrors it). */
  onChanged?: (entries: AllowlistEntry[] | null) => void;
  /** Reports server-derived transfer candidates to the owner-only Advanced section. */
  onTransferCandidatesChanged?: (candidates: TransferCandidate[] | null) => void;
  /** Bump after an external mutation (ownership transfer) to refresh the unified list. */
  refreshKey?: number;
}

const ROLE_LABEL: Record<AccessRole, string> = { viewer: "Viewer", editor: "Editor" };

function entryLabel(e: AllowlistEntry): string {
  if (e.kind === "team") return e.name ?? "Team";
  return e.email ?? e.name ?? "(unknown)";
}

/**
 * The unified people list (editor-roles plan, KD1/KTD5): the owner pinned first, then
 * people, pending invitees, and teams — each with a role control (viewer / editor; guests
 * are always viewers). The People/Teams tabs switch only the add form; the unified list
 * stays in place so changing input mode never changes the user's understanding of access.
 */
export function PeopleAccessList({
  canvasId,
  teams,
  orgs,
  onChanged,
  onTransferCandidatesChanged,
  refreshKey = 0,
}: PeopleAccessListProps) {
  const toast = useToast();
  const [entries, setEntries] = useState<AllowlistEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [email, setEmail] = useState("");
  const [personRole, setPersonRole] = useState<AccessRole>("viewer");
  const [teamId, setTeamId] = useState("");
  const [teamRole, setTeamRole] = useState<AccessRole>("viewer");
  const [addMode, setAddMode] = useState<"people" | "teams">("people");
  // One flag per action (review #21): adding a person never greys out Add team.
  const [personBusy, setPersonBusy] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  // KTD11 / AE19: after an editor leaves (removed or demoted), offer to rotate the deploy
  // key they may have copied. Declining removes only the grant.
  const [keyPrompt, setKeyPrompt] = useState<string | null>(null);
  // Removal is confirmed first (it is destructive for the person on their next request).
  const [removing, setRemoving] = useState<AllowlistEntry | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  // A canvas change can leave the previous allowlist request in flight. Only the latest
  // request may update either this component or the parent's list-aware copy.
  const requestGeneration = useRef(0);
  const peopleTab = useRef<HTMLButtonElement>(null);
  const teamsTab = useRef<HTMLButtonElement>(null);
  const tabsId = useId();
  const search = email.trim();
  const searchEnabled = search.length >= 2;
  const { data: suggestions = [], isFetching: searchingPeople } = usePeopleSearch(
    { context: "canvas", canvasId, q: search },
    searchEnabled,
  );

  const reload = () => {
    const generation = ++requestGeneration.current;
    setEntries(null);
    setLoadFailed(false);
    onChanged?.(null);
    onTransferCandidatesChanged?.(null);
    return api
      .listAllowlist(canvasId)
      .then((view) => {
        if (generation !== requestGeneration.current) return;
        setEntries(view.entries);
        setLoadFailed(false);
        onChanged?.(view.entries);
        const directEditors = view.entries
          .filter((e) => e.kind === "member" && e.role === "editor" && e.userId)
          .map((e) => ({ id: e.userId as string, name: e.name ?? "", email: e.email ?? "" }));
        onTransferCandidatesChanged?.(view.transferCandidates ?? directEditors);
      })
      .catch((err) => {
        if (generation !== requestGeneration.current) return;
        // Surface the failure instead of silently showing an empty list — an
        // inaccessible list must be distinguishable from a real-empty one.
        toast(err instanceof ApiError ? err.hint : "Couldn't load the access list", "error");
        setEntries([]);
        setLoadFailed(true);
        onTransferCandidatesChanged?.(null);
      });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load on canvas or parent refresh only
  useEffect(() => {
    void reload();
    return () => {
      requestGeneration.current += 1;
    };
  }, [canvasId, refreshKey]);

  const grantedTeamIds = new Set(
    (entries ?? []).filter((e) => e.kind === "team").map((e) => e.teamId),
  );
  const addableTeams = teams.filter((t) => !grantedTeamIds.has(t.id));
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
    <select
      aria-label={`Role for ${entryLabel(e)}`}
      className={`${inputControl} h-8 w-auto min-w-24 py-0 text-xs`}
      value={e.role === "editor" ? "editor" : "viewer"}
      onChange={(event) => {
        const next = event.target.value as AccessRole;
        if (next !== (e.role === "editor" ? "editor" : "viewer")) void changeRole(e, next);
      }}
    >
      <option value="viewer">Viewer</option>
      <option value="editor">Editor</option>
    </select>
  );

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs: Array<"people" | "teams"> = teams.length > 0 ? ["people", "teams"] : ["people"];
    const current = tabs.indexOf(addMode);
    const next =
      event.key === "Home"
        ? tabs[0]
        : event.key === "End"
          ? tabs[tabs.length - 1]
          : event.key === "ArrowRight"
            ? tabs[(current + 1) % tabs.length]
            : tabs[(current - 1 + tabs.length) % tabs.length];
    if (!next) return;
    setAddMode(next);
    (next === "people" ? peopleTab : teamsTab).current?.focus();
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        General access never removes people or teams listed here. Editors can also manage the
        canvas's content, settings, and sharing. Only org members and teams can be editors.
      </p>

      <div role="tablist" aria-label="Add direct access" className="flex border-b border-border">
        <button
          ref={peopleTab}
          id={`${tabsId}-people-tab`}
          type="button"
          role="tab"
          aria-selected={addMode === "people"}
          aria-controls={`${tabsId}-people-panel`}
          tabIndex={addMode === "people" ? 0 : -1}
          className={`border-b-2 px-3 py-2 text-sm font-medium ${
            addMode === "people"
              ? "border-accent text-fg"
              : "border-transparent text-muted hover:text-fg"
          }`}
          onClick={() => setAddMode("people")}
          onKeyDown={onTabKeyDown}
        >
          People
        </button>
        <button
          ref={teamsTab}
          id={`${tabsId}-teams-tab`}
          type="button"
          role="tab"
          aria-selected={addMode === "teams"}
          aria-controls={`${tabsId}-teams-panel`}
          tabIndex={addMode === "teams" ? 0 : -1}
          disabled={teams.length === 0}
          className={`border-b-2 px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
            addMode === "teams"
              ? "border-accent text-fg"
              : "border-transparent text-muted hover:text-fg"
          }`}
          onClick={() => setAddMode("teams")}
          onKeyDown={onTabKeyDown}
        >
          Teams
        </button>
      </div>

      {addMode === "people" ? (
        <div
          id={`${tabsId}-people-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-people-tab`}
          className="flex flex-wrap items-start gap-2"
        >
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
              inputClassName="h-10"
            />
          </div>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
            Role
            <select
              aria-label="Role for the person to add"
              className={`${inputControl} h-10 min-w-28 py-0`}
              value={personRole}
              onChange={(event) => setPersonRole(event.target.value as AccessRole)}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
          </label>
          <div className="flex flex-col gap-1.5">
            <span aria-hidden="true" className="invisible text-sm font-medium">
              Action
            </span>
            <Button
              size="md"
              loading={personBusy}
              disabled={!email.trim()}
              onClick={() => void addPerson()}
            >
              Add
            </Button>
          </div>
        </div>
      ) : (
        <div
          id={`${tabsId}-teams-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-teams-tab`}
          className="flex flex-wrap items-start gap-2"
        >
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1.5 text-sm font-medium text-fg">
            Team
            <select
              aria-label="Team to add"
              className={`${inputControl} h-10 py-0`}
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            >
              <option value="">Choose a team…</option>
              {addableTeams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                  {team.orgId === null ? " (personal)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
            Role
            <select
              aria-label="Role for the team to add"
              className={`${inputControl} h-10 min-w-28 py-0`}
              value={teamRole}
              onChange={(event) => setTeamRole(event.target.value as AccessRole)}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
          </label>
          <div className="flex flex-col gap-1.5">
            <span aria-hidden="true" className="invisible text-sm font-medium">
              Action
            </span>
            <Button size="md" loading={teamBusy} disabled={!teamId} onClick={() => void addTeam()}>
              Add
            </Button>
          </div>
        </div>
      )}

      {entries === null ? (
        <Skeleton className="h-8" />
      ) : loadFailed ? (
        <InlineNotice tone="warning" className="py-2 text-xs">
          Couldn't load the access list. Try again before relying on who appears here.
        </InlineNotice>
      ) : (
        <ul className="divide-y divide-border" aria-label="People and teams">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-fg">{entryLabel(e)}</span>
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
                {e.kind === "owner" ? (
                  <span className="text-xs font-medium text-fg">Owner</span>
                ) : e.kind === "guest" ? (
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
                  <ActionMenu label={`Actions for ${entryLabel(e)}`}>
                    <ActionMenuItem danger onSelect={() => setRemoving(e)}>
                      Remove
                    </ActionMenuItem>
                  </ActionMenu>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {entries !== null && !loadFailed && nonOwner.length === 0 && (
        <p className="text-xs text-muted">No one else has direct access yet.</p>
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
    </div>
  );
}
