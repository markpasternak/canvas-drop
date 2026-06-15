import { CaretRight } from "@phosphor-icons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { Button } from "../components/Button.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { Field, TextareaField } from "../components/Field.js";
import { PasswordField } from "../components/PasswordField.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { Row, RowDivider, Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { type AccessRung, type AllowlistEntry, ApiError, api } from "../lib/api.js";
import { deployCurl } from "../lib/deploy-curl.js";
import { relativeTime, toDatetimeLocal } from "../lib/format.js";
import {
  useArchiveCanvas,
  useDeleteCanvas,
  useRegenerateKey,
  useRegenerateSlug,
  useUnarchiveCanvas,
  useUnpublishCanvas,
  useUpdateSettings,
} from "../lib/mutations.js";
import { generatePassword } from "../lib/password.js";
import { useCanvas, useMe } from "../lib/queries.js";
import { useSectionNav } from "../lib/use-section-nav.js";

/** In-page section anchors drive both the section ids and the floating nav. */
const SECTIONS = [
  { id: "details", label: "Details" },
  { id: "sharing", label: "Sharing" },
  { id: "protection", label: "Protection" },
  { id: "url-key", label: "URL & key" },
  { id: "actions", label: "Actions" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "danger", label: "Danger zone" },
] as const;
const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Settings tab (§6.9.4): all canvas controls. Toggles are optimistic; password,
 * regen, and delete are confirm-and-await. Delete is a press-and-hold confirm. */
export default function Settings() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const toast = useToast();
  const { data: canvas, isLoading } = useCanvas(id);
  const { data: me } = useMe();

  const update = useUpdateSettings(id);
  const regenSlug = useRegenerateSlug(id);
  const regenKey = useRegenerateKey(id);
  const archive = useArchiveCanvas(id);
  const unarchive = useUnarchiveCanvas(id);
  const unpublish = useUnpublishCanvas(id);
  const del = useDeleteCanvas(id);

  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [confirm, setConfirm] = useState<
    null | "slug" | "key" | "archive" | "unpublish" | "delete" | "password-unlist"
  >(null);
  const urlCopyRef = useRef<HTMLButtonElement>(null);

  // Local mirrors for text fields (saved on blur).
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [gallerySummary, setGallerySummary] = useState("");
  const [galleryTags, setGalleryTags] = useState("");
  // Seed the local field mirrors once per canvas identity — NOT on every `canvas`
  // object change. An optimistic toggle rewrites the cached canvas object; keying
  // on canvas.id keeps in-progress (unblurred) text edits from being clobbered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed on identity change only
  useEffect(() => {
    if (!canvas) return;
    setTitle(canvas.title);
    setDescription(canvas.description ?? "");
    setGallerySummary(canvas.gallerySummary ?? "");
    setGalleryTags((canvas.galleryTags ?? []).join(", "));
  }, [canvas?.id]);

  const { active: activeSection, select: selectSection } = useSectionNav(SECTION_IDS, !!canvas);

  if (isLoading || !canvas) {
    return <Skeleton className="h-64" />;
  }

  const save = (patch: Parameters<typeof update.mutate>[0]) => update.mutate(patch);

  // The gallery toggles are pre-blocked when not listable, but a server rejection
  // (e.g. the canvas was unpublished in another tab) would otherwise roll back
  // silently — surface it. Other settings stay optimistic/fire-and-forget.
  const saveGallery = async (patch: Parameters<typeof update.mutate>[0]) => {
    try {
      await update.mutateAsync(patch);
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update the gallery setting", "error");
    }
  };

  // Sharing requires a published canvas (invariant: shared ⟹ published). null = it
  // can be shared. Leaving Published reverts share, so a Draft canvas is never shared.
  const shareBlocker =
    canvas.publicationState === "published" ? null : "Publish this canvas before sharing it.";

  // Why this canvas can't be listed in the gallery (null = it can). Order mirrors the
  // server's checks (plan 002): shared → published → unprotected.
  const listBlocker = !canvas.shared
    ? "Turn on Shared above to list this canvas in the gallery."
    : canvas.currentVersionId === null
      ? "Publish this canvas before listing it in the gallery."
      : canvas.hasPassword
        ? "Remove the password before listing this canvas in the gallery."
        : null;

  async function setOrClearPassword(next: string | null) {
    try {
      await update.mutateAsync({ password: next });
      setPassword("");
      setRevealPassword(false);
      toast(next ? "Password set" : "Password cleared");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update password", "error");
    }
  }

  return (
    <TabContentFrame className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <SettingsNav sections={SECTIONS} active={activeSection} onSelect={selectSection} />
      <div className="space-y-6">
        <Section id="details" title="Details">
          <Field
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== canvas.title && save({ title })}
            maxLength={200}
          />
          <TextareaField
            label="Description"
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() =>
              (description || null) !== canvas.description &&
              save({ description: description || null })
            }
            maxLength={2000}
          />
        </Section>

        <Section
          id="sharing"
          title="Sharing"
          description="Private by default. Pick who can open this canvas."
        >
          <AccessLadder
            value={canvas.access}
            disabled={shareBlocker !== null}
            allowPublic={me?.canPublishPublic ?? false}
            onChange={(access) => save({ access })}
          />
          {shareBlocker && (
            <InlineNotice tone="neutral" className="py-2 text-xs">
              {shareBlocker}
            </InlineNotice>
          )}
          {canvas.access === "specific_people" && (
            <>
              <Allowlist canvasId={canvas.id} />
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
            </>
          )}
          {canvas.shared && (
            <>
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
                <InlineNotice tone="warning" className="py-2 text-xs">
                  This share expired {relativeTime(canvas.sharedExpiresAt)} — non-owners now get a
                  404. Clear or extend the expiry to share it again.
                </InlineNotice>
              )}
            </>
          )}

          {/* Gallery listing. A listed canvas must be openable by org members without
              a password, and must actually exist at its URL — so listing requires
              shared + published + no password (plan 002). The control is always shown
              for discoverability, but disabled with the specific blocking reason. */}
          <div className="space-y-4 border-t border-border pt-4">
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
                  label="Gallery summary"
                  value={gallerySummary}
                  onChange={(e) => setGallerySummary(e.target.value)}
                  onBlur={() => save({ gallerySummary: gallerySummary || null })}
                  maxLength={500}
                />
                <Field
                  label="Tags"
                  hint="comma-separated"
                  value={galleryTags}
                  onChange={(e) => setGalleryTags(e.target.value)}
                  onBlur={() =>
                    save({
                      galleryTags: galleryTags
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <Toggle
                  label="Allow others to use as a template"
                  description="Let colleagues clone this canvas as a starting point for their own. They get an editable copy; your canvas is untouched."
                  checked={canvas.galleryTemplatable}
                  onChange={(galleryTemplatable) => void saveGallery({ galleryTemplatable })}
                />
              </>
            )}
          </div>
        </Section>

        <Section id="protection" title="Protection">
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
                  ? "Anyone you share the canvas with must enter this. You (the owner) and admins are never prompted. We store it hashed, so type a new one to change it."
                  : "Anyone you share the canvas with must enter this. You (the owner) and admins are never prompted. We store it hashed and can't show it again, so copy it now if you need to share it."
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
                  // Adding a password to a listed canvas removes it from the gallery —
                  // warn first (plan 002 R10). Changing an existing password (already
                  // unlisted) or an unlisted canvas needs no warning.
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
          <div className="border-t border-border pt-4">
            <Toggle
              label="Single-page app mode"
              description="Serve your home page for any unknown URL, so a JavaScript app's own routing works on reload and deep links. Leave off for multi-page sites, otherwise mistyped links show the home page instead of “not found.”"
              checked={canvas.spaFallback}
              onChange={(spaFallback) => save({ spaFallback })}
            />
          </div>
        </Section>

        <Section id="url-key" title="URL & key">
          <Row
            title="Canvas URL"
            description={<span className="block truncate font-mono">{canvas.url}</span>}
          >
            <CopyButton
              ref={urlCopyRef}
              value={canvas.url}
              label="Copy"
              toastMessage="Link copied"
            />
            <Button size="sm" variant="secondary" onClick={() => setConfirm("slug")}>
              Regenerate slug
            </Button>
          </Row>
          <RowDivider />
          <Row
            title="Secret API key"
            description="Regenerating invalidates the old key immediately."
          >
            <Button size="sm" variant="secondary" onClick={() => setConfirm("key")}>
              Regenerate key
            </Button>
          </Row>
          <RowDivider />
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-fg [&::-webkit-details-marker]:hidden">
              <CaretRight
                size={14}
                weight="bold"
                aria-hidden
                className="text-muted transition-transform duration-150 group-open:rotate-90"
              />
              Deploy with the API
            </summary>
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted">
                  Replace <code className="font-mono text-fg">$CANVAS_DROP_KEY</code> with your
                  secret key.
                </p>
                <CopyButton
                  value={deployCurl({ url: canvas.url, id: canvas.id, apiKey: "$CANVAS_DROP_KEY" })}
                  label="Copy"
                  toastMessage="Snippet copied"
                />
              </div>
              <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-4 font-mono text-xs text-muted">
                {deployCurl({ url: canvas.url, id: canvas.id, apiKey: "$CANVAS_DROP_KEY" })}
              </pre>
            </div>
          </details>
        </Section>

        <Section
          id="actions"
          title="Actions"
          description="Branch the work into a separate canvas without changing this one."
        >
          <Row
            title="Duplicate canvas"
            description="Creates a new canvas from the current published files and opens its draft."
          >
            <Button size="sm" variant="secondary" onClick={() => setCloneOpen(true)}>
              Duplicate canvas
            </Button>
          </Row>
        </Section>

        <Section
          id="lifecycle"
          title="Lifecycle"
          description="Take this canvas offline or retire it. Both keep every file, version, and setting."
        >
          {canvas.publicationState === "published" && (
            <Row
              title="Unpublish canvas"
              description="Takes it offline and back to Draft — still in your list and editable. Removed from the gallery if listed; re-publish any time."
            >
              <Button size="sm" variant="secondary" onClick={() => setConfirm("unpublish")}>
                Unpublish
              </Button>
            </Row>
          )}
          {canvas.status === "archived" ? (
            <Row
              title="This canvas is archived"
              description="It's offline and hidden from your main list. Unarchive it to bring it back at the same URL."
            >
              <Button
                size="sm"
                variant="secondary"
                loading={unarchive.isPending}
                onClick={async () => {
                  try {
                    await unarchive.mutateAsync();
                    toast("Canvas unarchived");
                  } catch (err) {
                    toast(err instanceof ApiError ? err.hint : "Couldn't unarchive", "error");
                  }
                }}
              >
                Unarchive
              </Button>
            </Row>
          ) : (
            <Row
              title="Archive canvas"
              description="Takes it offline and moves it to your Archived view. Reversible."
            >
              <Button size="sm" variant="secondary" onClick={() => setConfirm("archive")}>
                Archive canvas
              </Button>
            </Row>
          )}
        </Section>

        <Section id="danger" title="Danger zone" tone="danger">
          <Row
            title="Delete canvas"
            description="Takes it offline and removes it from your list. Recoverable for 30 days, then purged."
          >
            <Button variant="danger" size="sm" onClick={() => setConfirm("delete")}>
              Delete canvas
            </Button>
          </Row>
        </Section>
      </div>

      <ConfirmDialog
        open={confirm === "slug"}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            await regenSlug.mutateAsync();
            setConfirm(null);
            toast("Slug regenerated");
            requestAnimationFrame(() => urlCopyRef.current?.focus());
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't regenerate slug", "error");
          }
        }}
        title="Regenerate the slug?"
        actionLabel="Regenerate"
        loading={regenSlug.isPending}
      >
        The current URL will stop working
        {canvas.shared ? ", including the link you've shared with others" : ""}. A new URL is
        generated and shown here.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "key"}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            const { apiKey } = await regenKey.mutateAsync();
            setConfirm(null);
            setRevealedKey(apiKey);
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't regenerate key", "error");
          }
        }}
        title="Regenerate the API key?"
        actionLabel="Regenerate"
        loading={regenKey.isPending}
      >
        The current key stops working immediately. The new key is shown once.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "archive"}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            await archive.mutateAsync();
            setConfirm(null);
            toast("Canvas archived");
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't archive", "error");
          }
        }}
        title="Archive this canvas?"
        actionLabel="Archive"
        loading={archive.isPending}
      >
        It goes offline immediately
        {canvas.shared ? ", including the link you've shared with others" : ""}, and moves to your
        Archived view. Its files and settings are kept.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "unpublish"}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            await unpublish.mutateAsync();
            setConfirm(null);
            toast("Canvas unpublished");
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't unpublish", "error");
          }
        }}
        title="Unpublish this canvas?"
        actionLabel="Unpublish"
        loading={unpublish.isPending}
      >
        Its public URL goes offline immediately
        {canvas.shared ? ", including the link you've shared with others" : ""}, and it returns to
        Draft. It stays in your list and editable
        {canvas.galleryListed ? ", and is removed from the gallery" : ""}. Re-publish any time.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            await del.mutateAsync();
            toast("Canvas deleted");
            navigate({ to: "/" });
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't delete", "error");
          }
        }}
        title="Delete this canvas?"
        actionLabel="Hold to delete"
        destructive
        holdToConfirm
        loading={del.isPending}
      >
        This takes the canvas offline immediately and removes it from your list. It's recoverable
        for 30 days, then purged permanently.
      </ConfirmDialog>

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
        from the gallery (and turn off its template setting). You can re-list it after clearing the
        password.
      </ConfirmDialog>

      <CloneDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        sourceId={canvas.id}
        sourceTitle={canvas.title}
        keepsPassword={canvas.hasPassword}
        title="Duplicate canvas"
        actionLabel="Duplicate canvas"
      />

      {revealedKey && <ApiKeyReveal apiKey={revealedKey} onClose={() => setRevealedKey(null)} />}
    </TabContentFrame>
  );
}

/** Settable access rungs (D4). `public_link` is offered only to admin-granted accounts (U10). */
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
    hint: "Anyone with the link can view it (static only — no backend). Admin-granted.",
    adminGated: true,
  },
];

/** The access-rung selector — a radio group (the security-sensitive control gets a
 *  per-rung description, not a bare toggle). Non-private rungs are disabled until
 *  the canvas is published. `public_link` (admin-set) shows as a read-only note. */
function AccessLadder({
  value,
  disabled,
  allowPublic,
  onChange,
}: {
  value: AccessRung;
  disabled: boolean;
  /** Whether to offer the public_link rung (the account holds the admin grant, U10). */
  allowPublic: boolean;
  onChange: (rung: SettableRung) => void;
}) {
  // Hide the admin-gated public rung unless the account may publish it — except keep
  // it visible (read-only state) when the canvas is already public_link.
  const rungs = RUNGS.filter((r) => !r.adminGated || allowPublic || value === r.value);
  return (
    <fieldset className="space-y-2" aria-label="Who can access this canvas">
      {rungs.map((r) => {
        const blocked = disabled && r.value !== "private";
        return (
          <label
            key={r.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 ${
              value === r.value ? "border-accent bg-surface-sunken" : ""
            } ${blocked ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input
              type="radio"
              name="access-rung"
              className="mt-1"
              checked={value === r.value}
              disabled={blocked}
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
          Anyone with the link can view this canvas. It serves static files only — no KV, files, AI,
          or realtime.
        </InlineNotice>
      )}
    </fieldset>
  );
}

/** Manage the `specific_people` allowlist: list org members, add by email, remove.
 *  Inviting an outside email (a guest) arrives with the email-sharing flow (U8). */
function Allowlist({ canvasId }: { canvasId: string }) {
  const toast = useToast();
  const [entries, setEntries] = useState<AllowlistEntry[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = () => {
    api
      .listAllowlist(canvasId)
      .then(setEntries)
      .catch(() => setEntries([]));
  };
  // Load (and reload) the allowlist when the canvas identity changes.
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
        <p className="text-xs text-muted">No one added yet — only you and admins can open this.</p>
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
