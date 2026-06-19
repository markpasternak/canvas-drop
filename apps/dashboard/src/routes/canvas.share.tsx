import { ArrowSquareOut, LockKey } from "@phosphor-icons/react";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "../components/Button.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { Field } from "../components/Field.js";
import { IconLink } from "../components/IconButton.js";
import { PasswordField } from "../components/PasswordField.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { Row, Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice, Panel } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { type AccessRung, type AllowlistEntry, ApiError, api } from "../lib/api.js";
import { relativeTime, toDatetimeLocal } from "../lib/format.js";
import { usePublishDraft, useUpdateSettings } from "../lib/mutations.js";
import { generatePassword } from "../lib/password.js";
import { useCanvas, useMe } from "../lib/queries.js";
import { useSectionNav } from "../lib/use-section-nav.js";

const BASE_SECTIONS = [
  { id: "share-link", label: "Share link" },
  { id: "access", label: "Access" },
  { id: "locks", label: "Locks" },
  { id: "gallery", label: "Gallery" },
] as const;

const PEOPLE_SECTIONS = [
  { id: "share-link", label: "Share link" },
  { id: "access", label: "Access" },
  { id: "people", label: "People" },
  { id: "locks", label: "Locks" },
  { id: "guest-permissions", label: "Guest permissions" },
  { id: "gallery", label: "Gallery" },
] as const;

export default function Share() {
  const { id } = useParams({ strict: false }) as { id: string };
  const toast = useToast();
  const { data: canvas, isLoading } = useCanvas(id);
  const { data: me } = useMe();
  const update = useUpdateSettings(id);

  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [description, setDescription] = useState("");
  const [confirm, setConfirm] = useState<null | "password-unlist">(null);

  const sections = canvas?.access === "specific_people" ? PEOPLE_SECTIONS : BASE_SECTIONS;
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

  const listBlocker = !canvas.shared
    ? "Choose a shared access level before listing this canvas in the gallery."
    : canvas.currentVersionId === null
      ? "Publish this canvas before listing it in the gallery."
      : canvas.hasPassword
        ? "Remove the password before listing this canvas in the gallery."
        : null;

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

  return (
    <TabContentFrame className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <SettingsNav
        sections={sections}
        active={activeSection}
        onSelect={selectSection}
        ariaLabel="Share sections"
      />
      <div className="space-y-6">
        <Section
          id="share-link"
          title="Share link"
          description="Copy the URL people will use once this canvas is open to them."
        >
          <Row
            title="Canvas URL"
            description={<span className="block truncate font-mono">{canvas.url}</span>}
          >
            <CopyButton value={canvas.url} label="Copy" toastMessage="Link copied" />
            <IconLink href={canvas.url} target="_blank" rel="noreferrer" label="Open live canvas">
              <ArrowSquareOut size={15} weight="bold" aria-hidden />
            </IconLink>
          </Row>
        </Section>

        <Section
          id="access"
          title="Access"
          description="Pick the audience that can open this canvas."
        >
          <AccessLadder
            value={canvas.access}
            allowPublic={me?.canPublishPublic ?? false}
            onChange={(access) => save({ access })}
          />
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

        {canvas.access === "specific_people" && (
          <Section
            id="people"
            title="People"
            description="Add the people who can open this canvas."
          >
            <Allowlist canvasId={canvas.id} />
          </Section>
        )}

        <Section
          id="locks"
          title="Locks"
          description="Add extra checks after the access choice grants someone the link."
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
              <InlineNotice tone="warning" className="py-2 text-xs">
                This password has no effect until the canvas is shared. Private canvases are
                owner-only.
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

          {canvas.shared && (
            <div className="border-t border-border pt-4">
              <Field
                label="Share expiry"
                type="datetime-local"
                min={toDatetimeLocal(Date.now())}
                hint={canvas.sharedExpiresAt ? "auto-revokes at this time" : "optional"}
                defaultValue={canvas.sharedExpiresAt ? toDatetimeLocal(canvas.sharedExpiresAt) : ""}
                onBlur={(e) => {
                  const v = e.target.value ? new Date(e.target.value).getTime() : null;
                  if (v !== canvas.sharedExpiresAt) save({ sharedExpiresAt: v });
                }}
              />
              {canvas.sharedExpiresAt !== null && canvas.sharedExpiresAt <= Date.now() && (
                <InlineNotice tone="warning" className="mt-3 py-2 text-xs">
                  This share expired {relativeTime(canvas.sharedExpiresAt)}. Non-owners now get a
                  404. Clear or extend the expiry to share it again.
                </InlineNotice>
              )}
            </div>
          )}
        </Section>

        {canvas.access === "specific_people" && (
          <Section
            id="guest-permissions"
            title="Guest permissions"
            description="Control metered primitives for invited guests."
          >
            <Toggle
              label="Let invited guests use AI"
              description="Off by default. Guests can always use KV, files, and realtime; AI is the metered-cost primitive, so it's opt-in per canvas."
              checked={canvas.guestAiEnabled}
              onChange={(guestAiEnabled) => save({ guestAiEnabled })}
            />
            {canvas.guestAiEnabled && (
              <Field
                label="Guest AI spend cap (USD)"
                type="number"
                min="0"
                step="0.01"
                hint="Total guest AI spend allowed for this canvas. 0 disables guest AI spend."
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
            description="Show this canvas in the opt-in gallery with a title, summary, and tags."
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
                hint="shown publicly in the gallery when this canvas is listed"
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
                . They show here publicly once this canvas is listed.
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
    </TabContentFrame>
  );
}

/**
 * U13 — the single locked panel shown while a canvas isn't published yet. It states
 * the dependency ONCE (sharing unlocks after the canvas is live) instead of repeating
 * a "publish first" notice beneath every disabled access rung, lock, and gallery
 * control. The Publish CTA fires `usePublishDraft`, which invalidates the canvas-detail
 * query on success; `publicationState` flips to "published" and the parent re-renders
 * with the full access ladder / people / locks / gallery sections revealed in place —
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

type SettableRung = "private" | "specific_people" | "whole_org" | "public_link";
const RUNGS: { value: SettableRung; label: string; hint: string; adminGated?: boolean }[] = [
  { value: "private", label: "Private", hint: "Only you and admins can open this canvas." },
  {
    value: "specific_people",
    label: "Specific people",
    hint: "Only the people you add below can open it.",
  },
  {
    value: "whole_org",
    label: "Whole org",
    hint: "Anyone in your org with the link can open and use it.",
  },
  {
    value: "public_link",
    label: "Public link",
    hint: "Anyone with the link can view it (static only, no backend). Admin-granted.",
    adminGated: true,
  },
];

function AccessLadder({
  value,
  allowPublic,
  onChange,
}: {
  value: AccessRung;
  allowPublic: boolean;
  onChange: (rung: SettableRung) => void;
}) {
  const rungs = RUNGS.filter((r) => !r.adminGated || allowPublic || value === r.value);
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">Who can access this canvas</legend>
      {rungs.map((r) => {
        return (
          <label
            key={r.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 ${
              value === r.value ? "border-accent bg-surface-sunken" : ""
            }`}
          >
            <input
              type="radio"
              name="access-rung"
              className="mt-1"
              checked={value === r.value}
              onChange={() => onChange(r.value)}
            />
            <span>
              <span className="block text-sm font-semibold text-fg">{r.label}</span>
              <span className="block text-xs text-muted">{r.hint}</span>
            </span>
          </label>
        );
      })}
      {value === "public_link" && (
        <InlineNotice tone="warning" className="py-2 text-xs">
          Anyone with the link can view this canvas. It serves static files only: no KV, files, AI,
          or realtime.
        </InlineNotice>
      )}
    </fieldset>
  );
}

function Allowlist({ canvasId }: { canvasId: string }) {
  const toast = useToast();
  const [entries, setEntries] = useState<AllowlistEntry[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = () => {
    api
      .listAllowlist(canvasId)
      .then(setEntries)
      .catch((err) => {
        // Surface the failure instead of silently showing an empty list — an
        // inaccessible allowlist must be distinguishable from a real-empty one.
        toast(err instanceof ApiError ? err.hint : "Couldn't load the access list", "error");
        setEntries([]);
      });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load on canvasId change only
  useEffect(() => {
    reload();
  }, [canvasId]);

  async function add() {
    const value = email.trim();
    if (!value) return;
    setBusy(true);
    try {
      await api.addAllowlistMember(canvasId, value);
      setEmail("");
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't add that person", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(entryId: string) {
    try {
      await api.removeAllowlistEntry(canvasId, entryId);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't remove", "error");
    }
  }

  async function resend(entryId: string) {
    try {
      await api.resendAllowlistInvite(canvasId, entryId);
      toast("Invite re-sent");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't resend the invite", "error");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-xs text-muted">
        Add org members by email. They get access only to this canvas.
      </p>
      <div className="flex items-end gap-2">
        <Field
          label="Add by email"
          type="email"
          placeholder="colleague@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Button size="sm" variant="secondary" loading={busy} disabled={!email.trim()} onClick={add}>
          Add
        </Button>
      </div>
      {entries === null ? (
        <Skeleton className="h-8" />
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted">No one added yet. Only you and admins can open this.</p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                <span className="text-fg">{e.email ?? "(unknown)"}</span>
                {e.kind === "guest" && <span className="ml-2 text-xs text-muted">guest</span>}
              </span>
              <span className="flex gap-1">
                {e.kind === "guest" && (
                  <Button size="sm" variant="ghost" onClick={() => resend(e.id)}>
                    Resend
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => remove(e.id)}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
