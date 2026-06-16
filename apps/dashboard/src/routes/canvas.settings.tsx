import { ArrowSquareOut, CaretRight } from "@phosphor-icons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { Button } from "../components/Button.js";
import { TabContentFrame } from "../components/CanvasDetail.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { Field, TextareaField } from "../components/Field.js";
import { IconLink } from "../components/IconButton.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { Row, RowDivider, Section } from "../components/SettingsSection.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { ApiError } from "../lib/api.js";
import { deployCurl } from "../lib/deploy-curl.js";
import {
  useArchiveCanvas,
  useDeleteCanvas,
  useRegenerateKey,
  useRegenerateSlug,
  useUnarchiveCanvas,
  useUnpublishCanvas,
  useUpdateSettings,
} from "../lib/mutations.js";
import { useCanvas } from "../lib/queries.js";
import { useSectionNav } from "../lib/use-section-nav.js";

const SECTIONS = [
  { id: "basics", label: "Basics" },
  { id: "url-routing", label: "URL & routing" },
  { id: "deploy-api", label: "Deploy API" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "danger", label: "Danger zone" },
] as const;
const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Canvas settings for durable configuration and owner-only lifecycle actions.
 * Sharing and audience controls live in the Share tab. */
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
  const unpublish = useUnpublishCanvas(id);
  const del = useDeleteCanvas(id);

  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [confirm, setConfirm] = useState<
    null | "slug" | "key" | "archive" | "unpublish" | "delete"
  >(null);
  const urlCopyRef = useRef<HTMLButtonElement>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Seed local field mirrors on canvas identity only. Optimistic settings writes
  // replace the cached canvas object; keying on id preserves in-progress edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed on identity change only
  useEffect(() => {
    if (!canvas) return;
    setTitle(canvas.title);
    setDescription(canvas.description ?? "");
  }, [canvas?.id]);

  const { active: activeSection, select: selectSection } = useSectionNav(SECTION_IDS, !!canvas);

  if (isLoading || !canvas) {
    return <Skeleton className="h-64" />;
  }

  const save = (patch: Parameters<typeof update.mutate>[0]) => update.mutate(patch);

  return (
    <TabContentFrame className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <SettingsNav sections={SECTIONS} active={activeSection} onSelect={selectSection} />
      <div className="space-y-6">
        <Section id="basics" title="Basics">
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
          id="url-routing"
          title="URL & routing"
          description="Control the stable URL and how unknown paths resolve."
        >
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
            <IconLink href={canvas.url} target="_blank" rel="noreferrer" label="Open live canvas">
              <ArrowSquareOut size={15} weight="bold" aria-hidden />
            </IconLink>
            <Button size="sm" variant="secondary" onClick={() => setConfirm("slug")}>
              Regenerate slug
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
          id="deploy-api"
          title="Deploy API"
          description="Use the per-canvas key for scripted deploys. Never put it in canvas files."
        >
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
