import { useNavigate, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ApiKeyReveal } from "../components/ApiKeyReveal.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { Field, TextareaField } from "../components/Field.js";
import { PasswordField } from "../components/PasswordField.js";
import { Skeleton } from "../components/Skeleton.js";
import { useToast } from "../components/Toast.js";
import { Toggle } from "../components/Toggle.js";
import { ApiError } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import {
  useArchiveCanvas,
  useDeleteCanvas,
  useRegenerateKey,
  useRegenerateSlug,
  useUnarchiveCanvas,
  useUpdateSettings,
} from "../lib/mutations.js";
import { useCanvas } from "../lib/queries.js";

/** In-page section anchors — drive both the section ids and the floating nav. */
const SECTIONS = [
  { id: "details", label: "Details" },
  { id: "sharing", label: "Sharing" },
  { id: "protection", label: "Protection" },
  { id: "url-key", label: "URL & key" },
  { id: "archive", label: "Archive" },
  { id: "danger", label: "Danger zone" },
] as const;
const SECTION_IDS = SECTIONS.map((s) => s.id);

/** A strong, shareable password from an unambiguous alphabet (no 0/O/1/l/I).
 *  Uses the CSPRNG with rejection sampling so the distribution stays uniform. */
function generatePassword(length = 20): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  const out: string[] = [];
  while (out.length < length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (out.length >= length) break;
      if (b < max) out.push(alphabet[b % alphabet.length] as string);
    }
  }
  return out.join("");
}

/** A titled card grouping related controls. `tone="danger"` tints it for
 *  destructive actions (red border + heading), matching the danger token. */
function Section({
  id,
  title,
  description,
  tone = "default",
  children,
}: {
  id: string;
  title: string;
  description?: string;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      // Clear the sticky top bar (h-14) when jumped to via the section nav.
      className={cn(
        "scroll-mt-20 rounded-xl border bg-surface p-5 sm:p-6",
        tone === "danger" ? "border-danger/40" : "border-border",
      )}
    >
      <div className="mb-5 space-y-1">
        <h2 className={cn("text-sm font-semibold", tone === "danger" ? "text-danger" : "text-fg")}>
          {title}
        </h2>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** A single setting laid out as label/help on the left, control(s) on the
 *  right — generalizing the Toggle row idiom so actions read consistently. */
function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description && <div className="text-xs text-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** A hairline divider between rows inside a section. */
function RowDivider() {
  return <div className="border-t border-border" />;
}

/**
 * Drives the floating nav's active state. Active = the last section whose top
 * has scrolled past a line just below the sticky bar — EXCEPT:
 *   - at the page bottom, the last section wins (the lower sections can never
 *     reach the line otherwise, since there's no scroll room beneath them);
 *   - a click selects its target immediately and briefly suppresses the scroll
 *     computation so the smooth-scroll can settle without the highlight flicking.
 * `select` is what the nav links call. `ready` waits for the sections to mount.
 */
function useSectionNav(ids: readonly string[], ready: boolean) {
  const [active, setActive] = useState(ids[0] ?? "");
  const suppressUntil = useRef(0);

  useEffect(() => {
    if (!ready) return;
    const compute = () => {
      if (Date.now() < suppressUntil.current) return;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight > window.innerHeight + 4;
      // Bottom guard: reaching the end always lands on the final section.
      if (scrollable && window.scrollY + window.innerHeight >= doc.scrollHeight - 2) {
        setActive(ids[ids.length - 1] ?? "");
        return;
      }
      const line = 96; // just below the sticky top bar (h-14) + a little breathing room
      let current = ids[0] ?? "";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    };
    compute();
    window.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, [ids, ready]);

  const select = (id: string) => {
    setActive(id);
    suppressUntil.current = Date.now() + 700;
  };

  return { active, select };
}

/** Floating in-page table of contents for the (long) settings page. Sticks
 *  beside the content on wide screens; hidden on narrow ones where the page is
 *  short enough to scroll. Mirrors the detail-tab idiom (accent active border). */
function SettingsNav({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  return (
    <nav
      aria-label="Settings sections"
      className="hidden lg:block lg:sticky lg:top-20 lg:self-start"
    >
      <ul className="border-l border-border">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              onClick={() => onSelect(s.id)}
              aria-current={active === s.id ? "true" : undefined}
              className={cn(
                "-ml-px block border-l-2 py-1.5 pl-3 text-sm transition-colors duration-100 [transition-timing-function:var(--ease-out)]",
                active === s.id
                  ? "border-accent font-medium text-fg"
                  : "border-transparent text-muted hover:border-border-strong hover:text-fg",
              )}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

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
    <div className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-8">
      <SettingsNav active={activeSection} onSelect={selectSection} />
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
                  ? "Anyone you share the canvas with must enter this. You (the owner) and admins are never prompted. We store it hashed, so it can't be shown back to you — type a new one to change it."
                  : "Anyone you share the canvas with must enter this. You (the owner) and admins are never prompted. We store it hashed and can't show it again, so copy it now if you need to share it."
              }
            />
            {canvas.hasPassword && !canvas.shared && (
              <p className="rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning">
                This password has no effect until the canvas is shared — private canvases are
                owner-only.
              </p>
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
              label="SPA fallback"
              description="Serve index.html for unknown paths (single-page-app routing)."
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
          description="Retire a canvas without deleting it. Archiving takes it offline (its link stops working) but keeps every file and setting — restore it anytime."
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
        Archived view. Its files and settings are kept — unarchive anytime to bring it back.
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
    </div>
  );
}
