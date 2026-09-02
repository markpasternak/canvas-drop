import { Buildings, Globe, LockKey } from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Field } from "../components/Field.js";
import { PasswordField } from "../components/PasswordField.js";
import { PeopleAccessList } from "../components/PeopleAccessList.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { Row, Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice, Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import {
  type AccessRung,
  type AllowlistEntry,
  ApiError,
  isRestrictedRung,
  type TransferCandidate,
} from "../lib/api.js";
import { relativeTime, toDatetimeLocal } from "../lib/format.js";
import { usePublishDraft, useTransferCanvas, useUpdateSettings } from "../lib/mutations.js";
import { generatePassword } from "../lib/password.js";
import { useCanvas, useMe, useTeams } from "../lib/queries.js";
import { useSectionNav } from "../lib/use-section-nav.js";

const BASE_SECTIONS = [
  { id: "people", label: "Direct access" },
  { id: "access", label: "General access" },
  { id: "locks", label: "Protection" },
  { id: "gallery", label: "Gallery" },
] as const;

const PEOPLE_SECTIONS = [
  { id: "people", label: "Direct access" },
  { id: "access", label: "General access" },
  { id: "locks", label: "Protection" },
  { id: "added-people-ai", label: "Added people" },
  { id: "gallery", label: "Gallery" },
] as const;

const ADVANCED_SECTION = { id: "advanced", label: "Advanced" } as const;

export default function Share() {
  const { id } = useParams({ strict: false }) as { id: string };
  const toast = useToast();
  const { data: canvas, isLoading } = useCanvas(id);
  const { data: me } = useMe();
  // The caller's teams (plan 003) — the picker offers only the teams they BELONG to
  // (`mine`). Only meaningful under active tenancy; for a Personal-only caller this is [].
  const { data: teams } = useTeams();
  const update = useUpdateSettings(id);
  const transfer = useTransferCanvas(id);
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [description, setDescription] = useState("");
  const [confirm, setConfirm] = useState<null | "password-unlist">(null);
  const [transferCandidates, setTransferCandidates] = useState<TransferCandidate[] | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const [peopleRefreshKey, setPeopleRefreshKey] = useState(0);
  const activeCanvasId = useRef<string | null>(id);
  // The people-and-teams list as the list component last loaded it: drives the Restricted
  // hint ("only you" vs "you and the N above") and the legacy-guest AI section. `null` until
  // the list for THIS canvas has loaded (and after a failed load), so the copy below never
  // describes an empty list it has not actually seen (review #3).
  const [people, setPeople] = useState<AllowlistEntry[] | null>(null);
  useEffect(() => {
    activeCanvasId.current = id;
    setPeople(null);
    setTransferCandidates(null);
    setTransferOpen(false);
    setTransferTo(null);
    return () => {
      if (activeCanvasId.current === id) activeCanvasId.current = null;
    };
  }, [id]);
  const listLoaded = people !== null;
  // Who can open the canvas TODAY through the list: a pending invite has no user yet, so it
  // is not counted (review #4).
  const listedCount = (people ?? []).filter(
    (e) => e.kind !== "owner" && e.kind !== "pending",
  ).length;
  // The "AI for added people" controls gate LEGACY guest sessions (canvas-ai.ts keys on the
  // guest principal, at every rung), so they show exactly when such a guest is on the list.
  const hasLegacyGuest = (people ?? []).some((e) => e.kind === "guest");
  const isOwner = canvas?.role !== "editor";
  const sections = [
    ...(hasLegacyGuest ? PEOPLE_SECTIONS : BASE_SECTIONS),
    ...(isOwner ? [ADVANCED_SECTION] : []),
  ];
  const sectionIds = sections.map((s) => s.id);
  const { active: activeSection, select: selectSection } = useSectionNav(sectionIds, !!canvas);

  // Seed local field mirrors on canvas identity only. Optimistic settings writes
  // replace the cached canvas object; keying on id preserves in-progress edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed on identity change only
  useEffect(() => {
    if (!canvas) return;
    setDescription(canvas.description ?? "");
  }, [canvas?.id]);

  if (isLoading || !canvas) {
    return <Skeleton className="h-64" />;
  }

  const save = async (patch: Parameters<typeof update.mutate>[0]) => {
    // Optimistic write (onError rolls the cache back). This is the shared handler for
    // access / expiry / guest-AI changes, so a failure must surface — don't swallow it.
    // On success, surface the server's advisory (e.g. the CDN edge-cache staleness
    // notice on an access downgrade) as a toast.
    try {
      const { warning } = await update.mutateAsync(patch);
      if (warning) toast(warning);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't save that change", "error");
    }
  };

  const saveGallery = async (patch: Parameters<typeof update.mutate>[0]) => {
    try {
      await update.mutateAsync(patch);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update the gallery setting", "error");
    }
  };

  async function transferOwnership() {
    if (!transferTo) return;
    const transferCanvasId = id;
    try {
      const result = await transfer.mutateAsync(transferTo);
      if (activeCanvasId.current !== transferCanvasId) return;
      setTransferOpen(false);
      setPeopleRefreshKey((current) => current + 1);
      toast(
        result.publicLinkReverted
          ? "Ownership transferred. The public link was turned off because the new owner's account can't publish publicly."
          : "Ownership transferred. You're now an editor of this canvas.",
      );
    } catch (err) {
      if (activeCanvasId.current !== transferCanvasId) return;
      toast(err instanceof ApiError ? err.hint : "Couldn't transfer ownership", "error");
    }
  }

  // The gallery only ever lists Whole-org or Public-link canvases (mirrors the server's
  // galleryVisibilityFilters). A Restricted canvas can never appear, so
  // don't offer the toggle for it — explain instead of letting it save a no-op (plan 002
  // review fix; `canvas.shared` was too loose — it let specific_people through).
  const galleryEligible = canvas.access === "whole_org" || canvas.access === "public_link";
  const listBlocker = !galleryEligible
    ? "Only a Whole-org or Public-link canvas can be listed in the gallery."
    : canvas.currentVersionId === null
      ? "Publish this canvas before listing it in the gallery."
      : canvas.hasPassword
        ? "Remove the password before listing this canvas in the gallery."
        : null;

  const galleryDescription =
    canvas.access === "whole_org"
      ? "Anyone in your organization can discover and open this canvas."
      : canvas.access === "public_link"
        ? "Anyone signed in can discover this canvas; anyone with the link can open it."
        : "Show this canvas in the opt-in gallery with its title, description, and tags.";
  const galleryMetadataHint =
    canvas.access === "whole_org"
      ? "visible to your organization in the gallery when this canvas is listed"
      : "shown publicly in the gallery when this canvas is listed";
  const galleryTagsGuidance =
    canvas.access === "whole_org"
      ? "They are visible to your organization once this canvas is listed."
      : "They show here publicly once this canvas is listed.";

  async function setOrClearPassword(next: string | null) {
    try {
      const { warning } = await update.mutateAsync({ password: next });
      setPassword("");
      setRevealPassword(false);
      toast(next ? "Password set" : "Password cleared");
      if (warning) toast(warning);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update password", "error");
    }
  }

  // U13 — Guided share dependency flow. Sharing depends on the canvas being live, so
  // when it isn't published we explain that ONE time in a single locked panel (with a
  // Publish / Open-draft CTA) instead of repeating "publish first" beneath every
  // disabled rung and control. `shareBlocker`/`listBlocker` stay the gating source of
  // truth; this just collapses the unpublished view into one coherent explanation.
  // Publishing from the CTA invalidates the canvas-detail query (usePublishDraft), so
  // `publicationState` flips and this component re-renders with the full ladder in
  // place — no navigation, no manual reload.
  if (canvas.publicationState !== "published") {
    return <ShareLocked canvasId={canvas.id} />;
  }

  // Teams the caller can share THIS canvas to (plan 003 U6): their own teams (`mine`). A
  // personal team (org_id null) is grantable to any canvas; an org team to a same-org canvas —
  // the server re-checks via resolveTeamGrant, so an incompatible pick surfaces as a toast
  // rather than being silently hidden here.
  const shareableTeams = (teams ?? []).filter((t) => t.mine);
  return (
    <TabContentFrame className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <SettingsNav
        sections={sections}
        active={activeSection}
        onSelect={selectSection}
        ariaLabel="Share sections"
      />
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="font-display text-h1 leading-tight tracking-[var(--display-tracking)] text-fg">
            Sharing and permissions
          </h1>
          <p className="text-sm text-muted">
            Control who can open this canvas and what they can do.
          </p>
        </header>

        <Section
          id="people"
          title="People and teams with direct access"
          description="Add a person or team, then choose whether they can view or edit."
        >
          <PeopleAccessList
            canvasId={canvas.id}
            teams={shareableTeams}
            orgs={me?.orgs ?? []}
            onChanged={setPeople}
            refreshKey={peopleRefreshKey}
            onTransferCandidatesChanged={(candidates) => {
              setTransferCandidates(candidates);
              setTransferTo((current) =>
                current && candidates?.some((candidate) => candidate.id === current)
                  ? current
                  : (candidates?.[0]?.id ?? null),
              );
            }}
          />
        </Section>

        <Section
          id="access"
          title="General access"
          description="Who else can open the canvas, beyond the people and teams above."
        >
          <AccessLadder
            value={canvas.access}
            allowPublic={me?.canPublishPublic ?? false}
            // Offer the "Whole org" rung to everyone EXCEPT a guest (a signed-in user in
            // no org). `isGuest` is only ever true under active tenancy, so inert
            // instances keep offering it to all members (plan 002 U6).
            allowOrg={!me?.isGuest}
            // Disable "Whole org" on a Personal canvas (no home org) when the viewer is a
            // member — i.e. tenancy is active. The server would 409 it; don't make them
            // bounce off that with no feedback (plan 002).
            orgRungDisabled={canvas.orgId === null && (me?.orgs?.length ?? 0) > 0}
            // The Restricted hint tells the truth about the list: "only you" only when the
            // loaded list really is empty, otherwise how many people and teams it names; the
            // neutral sentence until the list has loaded.
            restrictedHint={
              !listLoaded
                ? "Only the people and teams above can open it."
                : listedCount === 0
                  ? "Only you currently have access. Add people or teams above to let them in."
                  : listedCount === 1
                    ? "Only you and the one person or team above can open it."
                    : `Only you and the ${listedCount} people and teams above can open it.`
            }
            // Restricted writes `private`; the legacy `specific_people` / `team` values
            // display as Restricted and are never written by the dashboard.
            onChange={(choice) => save({ access: choice === "restricted" ? "private" : choice })}
          />
          <p className="text-xs text-muted">
            Changing this never removes the people and teams above; it only decides who else gets
            in.
          </p>
          {canvas.access === "whole_org" && (
            <div className="border-t border-border pt-4">
              <Toggle
                label="List for your org"
                description="Show this canvas in Shared for everyone in your org. People and teams you add always see it there. Turning this off keeps URL access working."
                checked={canvas.discoverability === "listed"}
                onChange={(listed) => save({ discoverability: listed ? "listed" : "link_only" })}
              />
              {canvas.access === "whole_org" && canvas.galleryListed && (
                <InlineNotice tone="warning" className="mt-3 py-2 text-xs">
                  Turning this off also removes the canvas from the gallery.
                </InlineNotice>
              )}
            </div>
          )}
          {/* Heads-up (plan 004): a custom slug is human-guessable, so for link-reachable
              audiences the URL itself is no longer a secret — lean on the access controls,
              not obscurity. Informational, never a blocker. */}
          {canvas.slugCustom &&
            (canvas.access === "whole_org" || canvas.access === "public_link") && (
              <InlineNotice tone="accent" className="py-2 text-xs">
                This canvas has a custom, human-readable URL — easy to guess. Anyone allowed by the
                access level above can reach it; don't rely on the URL being secret.
              </InlineNotice>
            )}
        </Section>

        <Section
          id="locks"
          title="Protection"
          description="Require a password or stop access after a set time."
        >
          <div className="space-y-2">
            <PasswordField
              label="Password"
              autoComplete="new-password"
              placeholder={canvas.hasPassword ? "•••••••••• (a password is set)" : "No password"}
              value={password}
              revealed={revealPassword}
              onRevealedChange={setRevealPassword}
              onChange={(e) => setPassword(e.target.value)}
              hint={
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => {
                    setPassword(generatePassword());
                    setRevealPassword(true);
                  }}
                >
                  Generate
                </button>
              }
              description={
                canvas.hasPassword
                  ? "Non-owners who can open this canvas must enter this. We store it hashed, so type a new one to change it."
                  : "Non-owners who can open this canvas must enter this. We store it hashed and can't show it again, so copy it now if you need to share it."
              }
            />
            {canvas.hasPassword && !canvas.shared && (
              <InlineNotice tone="neutral" className="py-2 text-xs">
                {listLoaded && listedCount === 0
                  ? "Nobody but you can open this canvas yet, so the password gates no one until you add people or teams above, or widen General access."
                  : // Legacy guest sessions are never asked (the serve seam exempts the guest
                    // principal from the gate), nor are editors (review #2).
                    "The people and teams above are asked for this password too; editors and legacy guests never are."}
              </InlineNotice>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!password}
                loading={update.isPending}
                onClick={() =>
                  canvas.galleryListed
                    ? setConfirm("password-unlist")
                    : setOrClearPassword(password)
                }
              >
                {canvas.hasPassword ? "Change password" : "Set password"}
              </Button>
              {canvas.hasPassword && (
                <Button size="sm" variant="ghost" onClick={() => setOrClearPassword(null)}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          {(canvas.shared || canvas.sharedExpiresAt !== null || listedCount > 0) && (
            <div className="border-t border-border pt-4">
              <div className="space-y-2">
                <Field
                  label="Share expiry"
                  type="datetime-local"
                  min={toDatetimeLocal(Date.now())}
                  hint={canvas.sharedExpiresAt ? "Auto-unpublishes at this time" : "No expiry"}
                  defaultValue={
                    canvas.sharedExpiresAt ? toDatetimeLocal(canvas.sharedExpiresAt) : ""
                  }
                  onBlur={(e) => {
                    const v = e.target.value ? new Date(e.target.value).getTime() : null;
                    if (v !== canvas.sharedExpiresAt) save({ sharedExpiresAt: v });
                  }}
                />
                {canvas.sharedExpiresAt !== null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={update.isPending}
                    onClick={() => save({ sharedExpiresAt: null })}
                  >
                    Remove expiry
                  </Button>
                )}
              </div>
              {canvas.sharedExpiresAt !== null && canvas.sharedExpiresAt <= Date.now() && (
                <InlineNotice tone="warning" className="mt-3 py-2 text-xs">
                  This share expired {relativeTime(canvas.sharedExpiresAt)}. Non-owners now get a
                  404. Clear or extend the expiry to share it again.
                </InlineNotice>
              )}
            </div>
          )}
        </Section>

        {hasLegacyGuest && (
          <Section
            id="added-people-ai"
            title="AI for added people"
            description="Controls metered AI for people added to this canvas. This does not change your own AI budget."
          >
            {!isOwner && (
              <InlineNotice tone="neutral" className="py-2 text-xs">
                Only the owner can change the AI opt-in for added people — it is billed to their
                account.
              </InlineNotice>
            )}
            <Toggle
              label="Allow added people to use AI"
              description="Off by default. Added people can use KV, files, and realtime when those capabilities are enabled; AI is metered, so it is opt-in per canvas."
              checked={canvas.guestAiEnabled}
              disabled={!isOwner}
              onChange={(guestAiEnabled) => save({ guestAiEnabled })}
            />
            {isOwner && canvas.guestAiEnabled && (
              <Field
                label="Added people AI spend cap (USD)"
                type="number"
                min="0"
                step="0.01"
                hint="Total AI spend allowed for added people on this canvas. 0 disables their AI spend."
                defaultValue={String(canvas.guestAiCap)}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0 && v !== canvas.guestAiCap) {
                    save({ guestAiCap: v });
                  }
                }}
              />
            )}
          </Section>
        )}

        <Section
          id="gallery"
          title="Gallery & templates"
          description="Opt this canvas into discovery by colleagues."
        >
          <Toggle
            label="List in the gallery"
            description={galleryDescription}
            checked={canvas.galleryListed}
            disabled={listBlocker !== null}
            onChange={(galleryListed) => void saveGallery({ galleryListed })}
          />
          {listBlocker && (
            <InlineNotice tone="neutral" className="py-2 text-xs">
              {listBlocker}
            </InlineNotice>
          )}
          {canvas.galleryListed && (
            <>
              <Field
                label="Description"
                hint={galleryMetadataHint}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => save({ description: description || null })}
                maxLength={2000}
              />
              <InlineNotice tone="neutral" className="py-2 text-xs">
                Tags are set in{" "}
                <Link
                  to="/canvases/$id"
                  params={{ id: canvas.id }}
                  className="text-accent hover:underline"
                >
                  Overview
                </Link>
                . {galleryTagsGuidance}
              </InlineNotice>
              <Toggle
                label="Allow others to use as a template"
                description="Let colleagues clone this canvas as a starting point for their own. They get an editable copy; your canvas is untouched."
                checked={canvas.galleryTemplatable}
                onChange={(galleryTemplatable) => void saveGallery({ galleryTemplatable })}
              />
            </>
          )}
        </Section>

        {isOwner && (
          <Section
            id="advanced"
            title="Advanced"
            description="Owner-only actions that change who controls this canvas."
          >
            <Row
              title="Transfer ownership"
              description="Choose an existing editor as the new owner. The change takes effect immediately, and you remain an editor."
            >
              <Button
                size="sm"
                variant="secondary"
                disabled={(transferCandidates?.length ?? 0) === 0}
                title={
                  (transferCandidates?.length ?? 0) === 0
                    ? "Add an editor first. Ownership can only move to an editor."
                    : undefined
                }
                onClick={() => setTransferOpen(true)}
              >
                Transfer ownership
              </Button>
            </Row>
          </Section>
        )}
      </div>

      <ConfirmDialog
        open={confirm === "password-unlist"}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await setOrClearPassword(password);
        }}
        title="Add a password and unlist?"
        actionLabel="Add password & remove from gallery"
        loading={update.isPending}
      >
        Gallery canvases must be openable without a password. Adding one will remove this canvas
        from the gallery and turn off its template setting. You can re-list it after clearing the
        password.
      </ConfirmDialog>

      <ConfirmDialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        onConfirm={() => void transferOwnership()}
        title="Transfer ownership?"
        actionLabel="Transfer ownership"
        destructive
        loading={transfer.isPending}
      >
        <div className="space-y-3">
          <p>
            The person you pick becomes the owner immediately. Sharing, the public-link entitlement,
            and the deploy key follow their account. You keep editor access.
          </p>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-fg">New owner</legend>
            {(transferCandidates ?? []).map((candidate) => (
              <label
                key={candidate.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-hover"
              >
                <input
                  type="radio"
                  name="transfer-to"
                  checked={transferTo === candidate.id}
                  onChange={() => setTransferTo(candidate.id)}
                />
                <span className="text-sm text-fg">{candidate.name || candidate.email}</span>
                {candidate.name && candidate.email && (
                  <span className="text-xs text-muted">{candidate.email}</span>
                )}
              </label>
            ))}
          </fieldset>
          {(transferCandidates?.length ?? 0) === 0 && (
            <InlineNotice tone="neutral" className="py-2 text-xs">
              Add an editor first. Ownership can only move to an existing editor.
            </InlineNotice>
          )}
        </div>
      </ConfirmDialog>
    </TabContentFrame>
  );
}

/**
 * U13 — the single locked panel shown while a canvas isn't published yet. It states
 * the dependency ONCE (sharing unlocks after the canvas is live) instead of repeating
 * a "publish first" notice beneath every disabled access rung, protection control, and gallery
 * control. The Publish CTA fires `usePublishDraft`, which invalidates the canvas-detail
 * query on success; `publicationState` flips to "published" and the parent re-renders
 * with the full access ladder / people / protection / gallery sections revealed in place —
 * no navigation, no manual reload. Open draft routes to the editor for those who want
 * to keep working before going live.
 */
function ShareLocked({ canvasId }: { canvasId: string }) {
  const toast = useToast();
  const publish = usePublishDraft(canvasId);

  async function onPublish() {
    try {
      await publish.mutateAsync();
      toast("Published — sharing is unlocked");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't publish this canvas", "error");
    }
  }

  return (
    <TabContentFrame>
      <Panel className="max-w-xl" aria-labelledby="share-locked-heading">
        <div className="flex items-start gap-4">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-muted"
            aria-hidden
          >
            <LockKey size={20} weight="duotone" />
          </span>
          <div className="min-w-0 space-y-2">
            <h2 id="share-locked-heading" className="text-base font-semibold text-fg">
              Sharing unlocks after you publish
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              This canvas is still a draft, so it has no live URL yet. Access levels, people,
              passwords, and the gallery all describe a canvas people can open — publish it to put
              it live, then the full set of sharing controls appears here.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" loading={publish.isPending} onClick={onPublish}>
            Publish
          </Button>
          <Link
            to="/canvases/$id/editor"
            params={{ id: canvasId }}
            className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md border border-border-strong bg-surface-raised px-3 text-[0.8125rem] font-medium text-fg shadow-[var(--shadow-xs)] transition-colors duration-100 [transition-timing-function:var(--ease-out)] hover:bg-surface-hover"
          >
            Open draft
          </Link>
        </div>
      </Panel>
    </TabContentFrame>
  );
}

/** The three General-access choices (restricted access model). Restricted stands for the
 *  whole family — `private` and its legacy aliases `specific_people` / `team` — and always
 *  writes `private`. */
type RungChoice = "restricted" | "whole_org" | "public_link";
const RUNGS: {
  value: RungChoice;
  label: string;
  hint: string;
  adminGated?: boolean;
  orgGated?: boolean;
}[] = [
  {
    value: "restricted",
    label: "Restricted",
    // Replaced at render time by the list-aware `restrictedHint` (only-you vs the N above).
    hint: "Only the people and teams above can open it.",
  },
  {
    value: "whole_org",
    label: "Whole org",
    hint: "Anyone in your org with the link can open and use it — plus the people and teams above.",
    // Tenancy (plan 002 U6): hidden for a guest (a signed-in user in no org), for whom
    // sharing "with the org" is meaningless. The server denies it regardless.
    orgGated: true,
  },
  {
    value: "public_link",
    label: "Public link",
    hint: "Anyone with the link can view it (static only, no backend). People and teams above keep their full access. Admins can turn this off.",
    adminGated: true,
  },
];

/** The choice a stored rung displays as. */
function rungChoice(access: AccessRung): RungChoice {
  return isRestrictedRung(access) ? "restricted" : (access as RungChoice);
}

function AccessLadder({
  value,
  allowPublic,
  allowOrg,
  orgRungDisabled,
  restrictedHint,
  onChange,
}: {
  value: AccessRung;
  allowPublic: boolean;
  allowOrg: boolean;
  /** The Restricted choice's hint, computed from the loaded people-and-teams list. */
  restrictedHint: string;
  /** The "Whole org" rung is shown but DISABLED — this is a Personal canvas (no home org),
   *  so it can't be shared org-wide. Never let the user pick what can't work. */
  orgRungDisabled: boolean;
  onChange: (choice: RungChoice) => void;
}) {
  const choice = rungChoice(value);
  const rungs = RUNGS.filter(
    (r) =>
      (!r.adminGated || allowPublic || choice === r.value) &&
      (!r.orgGated || allowOrg || choice === r.value),
  );
  return (
    <fieldset className="grid gap-3 md:grid-cols-3">
      <legend className="sr-only">General access — who else can open this canvas</legend>
      {rungs.map((r) => {
        // A Personal canvas can't be shared org-wide — disable the "Whole org" rung + explain,
        // rather than letting the click bounce off the server's 409 with no feedback.
        const disabled = r.orgGated && orgRungDisabled && choice !== r.value;
        const selected = choice === r.value;
        const Icon =
          r.value === "restricted" ? LockKey : r.value === "whole_org" ? Buildings : Globe;
        return (
          <label
            key={r.value}
            className={`flex min-h-32 items-start gap-3 rounded-lg border border-border p-4 transition-colors ${
              disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer hover:bg-surface-hover"
            } ${selected ? "border-accent bg-surface-sunken" : "bg-surface"}`}
          >
            <input
              type="radio"
              name="access-rung"
              className="mt-1"
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(r.value)}
            />
            <Icon className="mt-0.5 shrink-0 text-muted" size={20} aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-fg">{r.label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted">
                {disabled
                  ? "This canvas is Personal — only a canvas in a workspace can be shared with your whole org."
                  : r.value === "restricted"
                    ? restrictedHint
                    : r.hint}
              </span>
            </span>
          </label>
        );
      })}
      {choice === "public_link" && (
        <InlineNotice tone="warning" className="col-span-full py-2 text-xs">
          Anyone with the link can view this canvas. It serves static files only: no KV, files, AI,
          or realtime.
        </InlineNotice>
      )}
    </fieldset>
  );
}
