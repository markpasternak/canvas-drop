import { ArrowSquareOut, UsersThree } from "@phosphor-icons/react";
import { useState } from "react";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { EmptyState } from "../components/EmptyState.js";
import { Field } from "../components/Field.js";
import { Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice, PageHeader, Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type Team } from "../lib/api.js";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useRemoveTeamMember,
  useRenameTeam,
} from "../lib/mutations.js";
import { useMe, useSharedWithTeams, useTeamMembers, useTeams } from "../lib/queries.js";

/**
 * Teams (plan 003 P2) — the self-serve team management surface + the "shared with my
 * teams" view (the only place strictly-team-scoped canvases surface; they never appear
 * in the org-wide gallery). Any org member can create a team and invite other members;
 * rename/delete is the creator's or an admin's (the server is authoritative — the UI
 * only gates affordances by the `canManage` hint and surfaces denials as toasts).
 */
export default function Teams() {
  const { data: me } = useMe();
  const { data: teams, isLoading } = useTeams();
  const orgs = me?.orgs ?? [];

  // Teams live inside an org workspace. A Personal-only caller (or a guest) has no org,
  // so there's nothing to manage — explain rather than show an empty create form.
  if (me && orgs.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Teams" description="Share canvases with a group inside your org." />
        <EmptyState
          icon={<UsersThree size={28} weight="duotone" />}
          title="Teams need an org workspace"
          description="Your account isn't part of an org workspace, so there are no teams to manage. Teams let colleagues in the same org share a subset of canvases with each other."
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Teams"
        description="Groups inside your org. Share a canvas with a team from its Share tab, and anyone on the team can open it."
      />

      <Section
        id="your-teams"
        title="Your teams"
        description="Create a team and invite colleagues, or browse the teams in your org."
      >
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <YourTeams teams={teams ?? []} defaultOrgId={orgs[0]?.id ?? null} orgs={orgs} />
        )}
      </Section>

      <Section
        id="shared-with-teams"
        title="Shared with your teams"
        description="Canvases other people shared with a team you belong to."
      >
        <SharedWithTeams />
      </Section>
    </div>
  );
}

/** The create form + the roster-managing list of the caller's org teams. */
function YourTeams({
  teams,
  defaultOrgId,
  orgs,
}: {
  teams: Team[];
  defaultOrgId: string | null;
  orgs: Array<{ id: string; name: string }>;
}) {
  const toast = useToast();
  const create = useCreateTeam();
  const [name, setName] = useState("");
  // P2 is single-org per instance; default to the caller's org. A future multi-org
  // instance (P3) would add a picker — keep the orgId explicit so that's a small change.
  const [orgId, setOrgId] = useState(defaultOrgId ?? "");

  async function submit() {
    const value = name.trim();
    if (!value || !orgId) return;
    try {
      await create.mutateAsync({ orgId, name: value });
      setName("");
      toast("Team created");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't create that team", "error");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
        {orgs.length > 1 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Org
            <select
              className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-fg"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
            >
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
          placeholder="Design, Growth, …"
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
          disabled={!name.trim() || !orgId}
          onClick={submit}
        >
          Create team
        </Button>
      </div>

      {teams.length === 0 ? (
        <p className="text-sm text-muted">No teams in your org yet. Create the first one above.</p>
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

/** A team's roster, plus the self-serve invite + leave controls (members only). */
function TeamRoster({ team }: { team: Team }) {
  const toast = useToast();
  const { data: me } = useMe();
  const { data: members, isLoading } = useTeamMembers(team.id);
  const add = useAddTeamMember(team.id);
  const removeMember = useRemoveTeamMember(team.id);
  const [email, setEmail] = useState("");

  async function invite() {
    const value = email.trim();
    if (!value) return;
    try {
      await add.mutateAsync(value);
      setEmail("");
      toast("Added to the team");
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
          <Field
            label="Add a colleague by email"
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void invite();
              }
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            loading={add.isPending}
            disabled={!email.trim()}
            onClick={invite}
          >
            Add
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
      ) : !members || members.length === 0 ? (
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
        </ul>
      )}
    </div>
  );
}

/** The "shared with my teams" canvas list — display-only cards linking to the live
 *  canvas (the caller isn't the owner, so there are no management actions here). */
function SharedWithTeams() {
  const { data: canvases, isLoading } = useSharedWithTeams();

  if (isLoading) return <Skeleton className="h-24" />;
  if (!canvases || canvases.length === 0) {
    return (
      <EmptyState
        icon={<UsersThree size={26} weight="duotone" />}
        title="Nothing shared with your teams yet"
        description="When a colleague shares a canvas with a team you're on, it shows up here so you can open it."
      />
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {canvases.map((cv) => (
        <Panel key={cv.id} className="flex flex-col gap-3 p-4">
          <div className="min-w-0 space-y-1">
            <p className="truncate text-sm font-medium text-fg">{cv.title || "Untitled canvas"}</p>
            {cv.description && <p className="line-clamp-2 text-xs text-muted">{cv.description}</p>}
            {cv.owner && <p className="text-xs text-subtle">by {cv.owner.name}</p>}
          </div>
          <a
            href={cv.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-3 text-[0.8125rem] font-medium text-fg transition-colors hover:bg-surface-hover"
          >
            Open
            <ArrowSquareOut size={13} weight="bold" aria-hidden />
          </a>
        </Panel>
      ))}
    </div>
  );
}
