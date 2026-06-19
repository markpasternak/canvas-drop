import { ArrowSquareOut, CaretRight, Warning } from "@phosphor-icons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { CanvasCover, previewCoverUrl } from "../components/CanvasCover.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { coverType } from "../components/GenerativeCover.js";
import { IconLink } from "../components/IconButton.js";
import { RenameSlugDialog } from "../components/RenameSlugDialog.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { Row, RowDivider, Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { ApiError } from "../lib/api.js";
import { deployCurl } from "../lib/deploy-curl.js";
import {
  useArchiveCanvas,
  useClearPreview,
  useDeleteCanvas,
  useRegenerateKey,
  useRegenerateSlug,
  useUnarchiveCanvas,
  useUnpublishCanvas,
  useUpdateSettings,
  useUploadPreview,
} from "../lib/mutations.js";
import { useCanvas, useMe } from "../lib/queries.js";
import { useSectionNav } from "../lib/use-section-nav.js";

const SECTIONS = [
  { id: "url-routing", label: "URL & routing" },
  { id: "preview", label: "Preview" },
  { id: "deploy-api", label: "Deploy API" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "danger", label: "Danger zone" },
] as const;

/** Max custom-preview upload (matches a single deploy blob server-side). */
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Canvas settings for durable configuration and owner-only lifecycle actions.
 * Identity lives in Overview; sharing and audience controls live in Share. */
export default function Settings() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const toast = useToast();
  const { data: canvas, isLoading } = useCanvas(id);
  const me = useMe().data;

  const update = useUpdateSettings(id);
  const uploadPreview = useUploadPreview(id);
  const clearPreview = useClearPreview(id);
  const regenSlug = useRegenerateSlug(id);
  const regenKey = useRegenerateKey(id);
  const archive = useArchiveCanvas(id);
  const unarchive = useUnarchiveCanvas(id);
  const unpublish = useUnpublishCanvas(id);
  const del = useDeleteCanvas(id);

  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [confirm, setConfirm] = useState<
    null | "slug" | "key" | "archive" | "unpublish" | "delete"
  >(null);
  const urlCopyRef = useRef<HTMLButtonElement>(null);
  const previewFileRef = useRef<HTMLInputElement>(null);

  const { active: activeSection, select: selectSection } = useSectionNav(SECTION_IDS, !!canvas);

  if (isLoading || !canvas) {
    return <Skeleton className="h-64" />;
  }

  const save = (patch: Parameters<typeof update.mutate>[0]) =>
    update.mutate(patch, {
      onError: (err) => toast(err instanceof ApiError ? err.hint : "Couldn't save", "error"),
    });

  const onPreviewFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Choose an image file", "error");
      return;
    }
    if (file.size > MAX_PREVIEW_BYTES) {
      toast("Image is larger than 25 MB", "error");
      return;
    }
    try {
      await uploadPreview.mutateAsync({ image: await file.arrayBuffer(), contentType: file.type });
      toast("Custom preview set");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't upload that image", "error");
    }
  };

  const previewBusy = uploadPreview.isPending || clearPreview.isPending;
  // Compute the deploy snippet once and reuse it for both the copy button and the
  // visible <pre> — building it twice risks the two surfaces drifting.
  const curlSnippet = deployCurl({ url: canvas.url, id: canvas.id, apiKey: "$CANVAS_DROP_KEY" });

  return (
    <TabContentFrame className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <SettingsNav sections={SECTIONS} active={activeSection} onSelect={selectSection} />
      <div className="space-y-6">
        <Section
          id="url-routing"
          title="URL & routing"
          description="Control the stable URL and how unknown paths resolve."
        >
          <Row
            title={
              <span className="flex flex-wrap items-center gap-2">
                Canvas URL
                <Badge tone="accent">Changes the link</Badge>
              </span>
            }
            description={<span className="block truncate font-mono">{canvas.url}</span>}
          >
            <CopyButton
              ref={urlCopyRef}
              value={canvas.url}
              label="Copy"
              toastMessage="Link copied"
            />
            <IconLink href={canvas.url} target="_blank" rel="noreferrer" label="Open live canvas">
              <ArrowSquareOut size={15} weight="bold" aria-hidden />
            </IconLink>
            <Button size="sm" variant="secondary" onClick={() => setConfirm("slug")}>
              Change slug
            </Button>
          </Row>
          <RowDivider />
          <Toggle
            label="Single-page app mode"
            description="Serve your home page for any unknown URL, so a JavaScript app's own routing works on reload and deep links. Leave off for multi-page sites, otherwise mistyped links show the home page instead of not found."
            checked={canvas.spaFallback}
            onChange={(spaFallback) => save({ spaFallback })}
          />
        </Section>

        <Section
          id="preview"
          title="Preview"
          description="The cover image shown for this canvas in your dashboard and the gallery."
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="aspect-[3/2] w-full max-w-[14rem] shrink-0 overflow-hidden rounded-xl border border-border">
              <CanvasCover
                seed={canvas.id}
                title={canvas.title ?? undefined}
                type={coverType({
                  templatable: canvas.galleryTemplatable,
                  listed: canvas.galleryListed,
                  protectedByPassword: canvas.hasPassword,
                })}
                status={canvas.publicationState}
                previewUrl={
                  canvas.hasPreview
                    ? `${previewCoverUrl(canvas.url, "card")}&v=${canvas.updatedAt}`
                    : undefined
                }
              />
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              {canvas.previewMode === "custom" ? (
                <>
                  <p className="text-sm text-fg">Using a custom image you uploaded.</p>
                  <p className="text-xs text-muted">
                    It stays put — publishing new versions won't overwrite it.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={uploadPreview.isPending}
                      disabled={previewBusy}
                      onClick={() => previewFileRef.current?.click()}
                    >
                      Replace image
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={clearPreview.isPending}
                      disabled={previewBusy}
                      onClick={async () => {
                        try {
                          await clearPreview.mutateAsync();
                          toast("Reverted to automatic preview");
                        } catch (err) {
                          toast(
                            err instanceof ApiError ? err.hint : "Couldn't remove the image",
                            "error",
                          );
                        }
                      }}
                    >
                      Remove custom image
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Badge tone="accent">Changes what others see</Badge>
                  <Toggle
                    label="Generate a preview automatically"
                    description="Capture a screenshot of your canvas each time you publish, and use it as the cover. Turn off to show a generated placeholder instead."
                    checked={canvas.previewMode === "auto"}
                    onChange={(on) => save({ previewMode: on ? "auto" : "off" })}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={uploadPreview.isPending}
                    disabled={previewBusy}
                    onClick={() => previewFileRef.current?.click()}
                  >
                    Upload custom image
                  </Button>
                </>
              )}
            </div>
          </div>
          <input
            ref={previewFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPreviewFile}
          />
        </Section>

        <Section
          id="deploy-api"
          title="Deploy API"
          description="Use the per-canvas key for scripted deploys. Never put it in canvas files."
        >
          <Row
            title={
              <span className="flex flex-wrap items-center gap-2">
                Secret API key
                <Badge tone="warning">Credential</Badge>
              </span>
            }
            description="Regenerating invalidates the old key immediately — any scripts or agents using the old key will stop deploying until you update them."
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
                <CopyButton value={curlSnippet} label="Copy" toastMessage="Snippet copied" />
              </div>
              <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-4 font-mono text-xs text-muted">
                {curlSnippet}
              </pre>
            </div>
          </details>
        </Section>

        <Section
          id="lifecycle"
          title="Lifecycle"
          description="Duplicate, take offline, or retire this canvas without deleting it."
        >
          <Row
            title="Duplicate canvas"
            description="Creates a new canvas from the current published files and opens its draft."
          >
            <Button size="sm" variant="secondary" onClick={() => setCloneOpen(true)}>
              Duplicate canvas
            </Button>
          </Row>
          <RowDivider />
          {canvas.publicationState === "published" && (
            <>
              <Row
                title="Unpublish canvas"
                description="Takes it offline and back to Draft. It stays in your list and editable."
              >
                <Button size="sm" variant="secondary" onClick={() => setConfirm("unpublish")}>
                  Unpublish
                </Button>
              </Row>
              <RowDivider />
            </>
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
              description="Takes it offline and moves it to your Archived view — anyone with the link loses access until you unarchive. Reversible."
            >
              <Button size="sm" variant="danger" onClick={() => setConfirm("archive")}>
                <Warning size={15} weight="bold" aria-hidden />
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
              <Warning size={15} weight="bold" aria-hidden />
              Delete canvas
            </Button>
          </Row>
        </Section>
      </div>

      <RenameSlugDialog
        open={confirm === "slug"}
        onClose={() => setConfirm(null)}
        onConfirm={async (slug) => {
          try {
            await regenSlug.mutateAsync(slug);
            setConfirm(null);
            toast(slug ? "Slug changed" : "Slug regenerated");
            requestAnimationFrame(() => urlCopyRef.current?.focus());
          } catch (err) {
            toast(err instanceof ApiError ? err.hint : "Couldn't change the slug", "error");
          }
        }}
        me={me}
        shared={canvas.shared}
        loading={regenSlug.isPending}
      />

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
