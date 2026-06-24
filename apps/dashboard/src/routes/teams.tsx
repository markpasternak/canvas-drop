import { useState } from "react";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Field } from "../components/Field.js";
import { PeopleEmailCombobox } from "../components/PeopleEmailCombobox.js";
import { Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice, PageHeader } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type Team } from "../lib/api.js";
import { addPersonFeedback } from "../lib/invite-feedback.js";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useRemoveTeamMember,
  useRenameTeam,
} from "../lib/mutations.js";
import { useMe, usePeopleSearch, useTeamMembers, useTeams } from "../lib/queries.js";

/**
 * Teams (plan 003 P2/U6) — the self-serve team management surface + the "shared with my
 * teams" view (the only place strictly-team-scoped canvases surface; they never appear
 * in the org-wide gallery). ANY signed-in user can create a PERSONAL team (friends & family,
 * no org) and add people; an org member may also attach a team to their org. Rename/delete
 * is the creator's or an admin's (the server is authoritative — the UI only gates affordances
 * by the `canManage` hint and surfaces denials as toasts).
 */
export default function Teams() {
  const { data: me } = useMe();
  const { data: teams, isLoading } = useTeams();
  const orgs = me?.orgs ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Teams"
        description="A team is a group you share canvases with. Share a canvas with a team from its Share tab, and anyone on the team can open it."
      />

      <Section
        id="your-teams"
        title="Your teams"
        description="Create a personal team and add people by email, or attach a team to an org you belong to."
      >
        {isLoading ? <Skeleton className="h-24" /> : <YourTeams teams={teams ?? []} orgs={orgs} />}
      </Section>
    </div>
  );
}

/** The create form + the roster-managing list of the caller's teams. The "Personal vs Org"
 *  choice is fixed at creation: a no-org user sees only Personal; an org member sees both. */
function YourTeams({ teams, orgs }: { teams: Team[]; orgs: Array<{ id: string; name: string }> }) {
  const toast = useToast();
  const create = useCreateTeam();
  const [name, setName] = useState("");
  // "" = a personal team (no org); otherwise the chosen org id. Default to Personal.
  const [orgId, setOrgId] = useState("");

  async function submit() {
    const value = name.trim();
    if (!value) return;
    try {
      await create.mutateAsync({ orgId: orgId === "" ? null : orgId, name: value });
      setName("");
      toast("Team created");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't create that team", "error");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
        {orgs.length > 0 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Team type
            <select
              className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-fg"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              aria-label="Team type"
            >
              <option value="">Personal</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Field
          label="New team name"
          placeholder="Family, Design, …"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          loading={create.isPending}
          disabled={!name.trim()}
          onClick={submit}
        >
          Create team
        </Button>
      </div>

      {teams.length === 0 ? (
        <p className="text-sm text-muted">No teams yet. Create the first one above.</p>
      ) : (
        <ul className="space-y-2">
          {teams.map((team) => (
            <TeamRow key={team.id} team={team} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One team: name + membership badge, an expandable roster, and the management
 *  affordances (add/leave for members, rename/delete for the creator/admin). */
function TeamRow({ team }: { team: Team }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(team.name);
  const rename = useRenameTeam();
  const remove = useDeleteTeam();

  async function doRename() {
    const value = renameValue.trim();
    if (!value || value === team.name) {
      setRenaming(false);
      return;
    }
    try {
      await rename.mutateAsync({ id: team.id, name: value });
      setRenaming(false);
      toast("Team renamed");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't rename the team", "error");
    }
  }

  async function doDelete() {
    setConfirmDelete(false);
    try {
      await remove.mutateAsync(team.id);
      toast("Team deleted");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't delete the team", "error");
    }
  }

  return (
    <li className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          {renaming ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: focus the rename input the user just opened
              autoFocus
              className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void doRename();
                } else if (e.key === "Escape") {
                  setRenaming(false);
                  setRenameValue(team.name);
                }
              }}
              aria-label={`Rename ${team.name}`}
            />
          ) : (
            <span className="truncate text-sm font-medium text-fg">{team.name}</span>
          )}
          {team.orgId === null && <Badge tone="neutral">Personal</Badge>}
          {team.mine && <Badge tone="accent">Member</Badge>}
        </div>
        <div className="flex items-center gap-1">
          {renaming ? (
            <>
              <Button size="sm" variant="secondary" loading={rename.isPending} onClick={doRename}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRenaming(false);
                  setRenameValue(team.name);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
                {open ? "Hide members" : "Members"}
              </Button>
              {team.canManage && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
                    Rename
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                    Delete
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {open && <TeamRoster team={team} />}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={doDelete}
        title={`Delete “${team.name}”?`}
        actionLabel="Delete team"
        destructive
        loading={remove.isPending}
      >
        Deleting this team removes its members and unshares every canvas shared with it. Canvases
        themselves aren't deleted, but anyone who reached them only through this team will lose
        access. This can't be undone.
      </ConfirmDialog>
    </li>
  );
}

/** A team's roster, plus the self-serve Add person + leave controls (members only). */
function TeamRoster({ team }: { team: Team }) {
  const toast = useToast();
  const { data: me } = useMe();
  const { data: roster, isLoading } = useTeamMembers(team.id);
  const add = useAddTeamMember(team.id);
  const removeMember = useRemoveTeamMember(team.id);
  const [email, setEmail] = useState("");
  const members = roster?.members ?? [];
  const pending = roster?.pending ?? [];
  const personal = team.orgId === null;
  const search = email.trim();
  const searchEnabled = team.mine && !personal && search.length >= 2;
  const { data: suggestions = [], isFetching: searchingPeople } = usePeopleSearch(
    { context: "team", teamId: team.id, q: search },
    searchEnabled,
  );

  async function addPerson() {
    const value = email.trim();
    if (!value) return;
    try {
      const r = await add.mutateAsync(value);
      setEmail("");
      const feedback = addPersonFeedback("team", r.status, r.emailDelivery);
      toast(feedback.message, feedback.tone);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add that person", "error");
    }
  }

  async function kick(userId: string, isSelf: boolean) {
    try {
      await removeMember.mutateAsync(userId);
      toast(isSelf ? "You left the team" : "Removed from the team");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't remove that member", "error");
    }
  }

  return (
    <div className="space-y-3 border-t border-border p-3">
      {team.mine && (
        <div className="flex items-end gap-2">
          <PeopleEmailCombobox
            label="Person's email"
            placeholder={personal ? "friend@example.com" : "colleague@example.com"}
            value={email}
            onChange={setEmail}
            onSubmit={() => void addPerson()}
            suggestions={suggestions}
            searchEnabled={searchEnabled}
            searching={searchingPeople}
          />
          <Button
            size="sm"
            variant="secondary"
            loading={add.isPending}
            disabled={!email.trim()}
            onClick={addPerson}
          >
            Add person
          </Button>
        </div>
      )}
      {!team.mine && (
        <InlineNotice tone="neutral" className="py-2 text-xs">
          You're not a member of this team. A member can add you by email.
        </InlineNotice>
      )}

      {isLoading ? (
        <Skeleton className="h-8" />
      ) : members.length === 0 && pending.length === 0 ? (
        <p className="text-xs text-muted">No members yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {members.map((m) => {
            const isSelf = m.userId === me?.id;
            return (
              <li key={m.userId} className="flex items-center justify-between py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-fg">{m.name ?? m.email ?? "(unknown)"}</span>
                  {m.name && m.email && (
                    <span className="block truncate text-xs text-muted">{m.email}</span>
                  )}
                </span>
                {team.mine && (
                  <Button size="sm" variant="ghost" onClick={() => kick(m.userId, isSelf)}>
                    {isSelf ? "Leave" : "Remove"}
                  </Button>
                )}
              </li>
            );
          })}
          {/* Pending access: brand-new people who haven't signed in yet. They become
              full members on their first verified login. */}
          {pending.map((p) => (
            <li
              key={`pending:${p.email}`}
              className="flex items-center justify-between py-2 text-sm"
            >
              <span className="min-w-0 truncate text-muted">{p.email}</span>
              <Badge tone="neutral">Pending sign-in</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
