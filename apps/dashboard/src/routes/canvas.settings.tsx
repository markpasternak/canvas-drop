import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { Button } from "../components/Button.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
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
import { ApiError } from "../lib/api.js";
import { toDatetimeLocal } from "../lib/format.js";
import {
  useArchiveCanvas,
  useDeleteCanvas,
  useRegenerateKey,
  useRegenerateSlug,
  useUnarchiveCanvas,
  useUpdateSettings,
} from "../lib/mutations.js";
import { generatePassword } from "../lib/password.js";
import { useCanvas } from "../lib/queries.js";
import { useSectionNav } from "../lib/use-section-nav.js";

/** In-page section anchors drive both the section ids and the floating nav. */
const SECTIONS = [
  { id: "details", label: "Details" },
  { id: "sharing", label: "Sharing" },
  { id: "protection", label: "Protection" },
  { id: "url-key", label: "URL & key" },
  { id: "archive", label: "Archive" },
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

  const update = useUpdateSettings(id);
  const regenSlug = useRegenerateSlug(id);
  const regenKey = useRegenerateKey(id);
  const archive = useArchiveCanvas(id);
  const unarchive = useUnarchiveCanvas(id);
  const del = useDeleteCanvas(id);

  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "slug" | "key" | "archive" | "delete">(null);
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
          description="Private by default. Sharing lets any signed-in colleague with the link open it."
        >
          <Toggle
            label="Shared"
            description="Anyone in your org with the link can open and use this canvas."
            checked={canvas.shared}
            onChange={(shared) => save({ shared })}
          />
          {canvas.shared && (
            <>
              <Field
                label="Share expiry"
                type="datetime-local"
                hint={canvas.sharedExpiresAt ? "auto-revokes at this time" : "optional"}
                defaultValue={canvas.sharedExpiresAt ? toDatetimeLocal(canvas.sharedExpiresAt) : ""}
                onBlur={(e) => {
                  const v = e.target.value ? new Date(e.target.value).getTime() : null;
                  if (v !== canvas.sharedExpiresAt) save({ sharedExpiresAt: v });
                }}
              />
              {/* Gallery is only meaningful for shared canvases, so it stays hidden until shared. */}
              <div className="space-y-4 border-t border-border pt-4">
                <Toggle
                  label="List in the gallery"
                  description="Show this canvas in the opt-in gallery with a title, summary, and tags."
                  checked={canvas.galleryListed}
                  onChange={(galleryListed) => save({ galleryListed })}
                />
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
                  </>
                )}
              </div>
            </>
          )}
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
                onClick={() => setOrClearPassword(password)}
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
        </Section>

        <Section
          id="archive"
          title="Archive"
          description="Retire a canvas without deleting it. Archiving takes it offline but keeps every file and setting."
        >
          {canvas.status === "archived" ? (
            <Row
              title="This canvas is archived"
              description="It's offline and hidden from your main list. Restore it to bring it back live at the same URL."
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

      {revealedKey && <ApiKeyReveal apiKey={revealedKey} onClose={() => setRevealedKey(null)} />}
    </TabContentFrame>
  );
}
