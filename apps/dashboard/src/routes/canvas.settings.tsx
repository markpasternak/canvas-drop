import { useNavigate, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { Field, TextareaField } from "../components/Field.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { ApiError } from "../lib/api.js";
import {
  useDeleteCanvas,
  useRegenerateKey,
  useRegenerateSlug,
  useUpdateSettings,
} from "../lib/mutations.js";
import { useCanvas } from "../lib/queries.js";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Settings tab (§6.9.4): all canvas controls. Toggles are optimistic; password,
 * regen, and delete are confirm-and-await. Delete is type-to-confirm the slug. */
export default function Settings() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const toast = useToast();
  const { data: canvas, isLoading } = useCanvas(id);

  const update = useUpdateSettings(id);
  const regenSlug = useRegenerateSlug(id);
  const regenKey = useRegenerateKey(id);
  const del = useDeleteCanvas(id);

  const [password, setPassword] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "slug" | "key" | "delete">(null);
  const urlCopyRef = useRef<HTMLButtonElement>(null);

  // Local mirrors for text fields (saved on blur).
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [gallerySummary, setGallerySummary] = useState("");
  const [galleryTags, setGalleryTags] = useState("");
  useEffect(() => {
    if (!canvas) return;
    setTitle(canvas.title);
    setDescription(canvas.description ?? "");
    setGallerySummary(canvas.gallerySummary ?? "");
    setGalleryTags((canvas.galleryTags ?? []).join(", "));
  }, [canvas]);

  if (isLoading || !canvas) {
    return <Skeleton className="h-64" />;
  }

  const save = (patch: Parameters<typeof update.mutate>[0]) => update.mutate(patch);

  async function setOrClearPassword(next: string | null) {
    try {
      await update.mutateAsync({ password: next });
      setPassword("");
      toast(next ? "Password set" : "Password cleared");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't update password", "error");
    }
  }

  return (
    <div className="space-y-4">
      <Section title="Details">
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
              defaultValue={
                canvas.sharedExpiresAt
                  ? new Date(canvas.sharedExpiresAt).toISOString().slice(0, 16)
                  : ""
              }
              onBlur={(e) => {
                const v = e.target.value ? new Date(e.target.value).getTime() : null;
                if (v !== canvas.sharedExpiresAt) save({ sharedExpiresAt: v });
              }}
            />
            {/* Gallery: only meaningful for shared canvases — hidden until shared. */}
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

      <Section title="Protection">
        <div className="space-y-2">
          <Field
            label="Password"
            type="password"
            placeholder={canvas.hasPassword ? "•••••••• (set)" : "No password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            description="Visitors must enter this before the canvas loads."
          />
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
            label="SPA fallback"
            description="Serve index.html for unknown paths (single-page-app routing)."
            checked={canvas.spaFallback}
            onChange={(spaFallback) => save({ spaFallback })}
          />
        </div>
      </Section>

      <Section title="URL & key">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">Canvas URL</p>
            <p className="truncate font-mono text-xs text-muted">{canvas.url}</p>
          </div>
          <div className="flex items-center gap-1">
            <CopyButton
              ref={urlCopyRef}
              value={canvas.url}
              label="Copy"
              toastMessage="Link copied"
            />
            <Button size="sm" variant="secondary" onClick={() => setConfirm("slug")}>
              Regenerate slug
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            <p className="text-sm font-medium text-fg">Secret API key</p>
            <p className="text-xs text-muted">Regenerating invalidates the old key immediately.</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setConfirm("key")}>
            Regenerate key
          </Button>
        </div>
      </Section>

      <Section
        title="Danger zone"
        description="Deleting soft-deletes the canvas; it's purged after 30 days."
      >
        <Button variant="danger" size="sm" onClick={() => setConfirm("delete")}>
          Delete canvas
        </Button>
      </Section>

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
        actionLabel="Delete canvas"
        destructive
        loading={del.isPending}
        confirmPhrase={canvas.slug}
        confirmPhraseLabel={`Type the slug "${canvas.slug}" to confirm`}
      >
        This soft-deletes the canvas and takes its URL offline. It's purged permanently after 30
        days.
      </ConfirmDialog>

      {revealedKey && <ApiKeyReveal apiKey={revealedKey} onClose={() => setRevealedKey(null)} />}
    </div>
  );
}
