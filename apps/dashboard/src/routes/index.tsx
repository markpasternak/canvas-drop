import { MagnifyingGlass } from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "../components/Button.js";
import { CanvasRow, DefaultRowActions, ListSkeleton } from "../components/CanvasList.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { PageHeader } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, CANVASES_PAGE_SIZE, type CanvasListItem } from "../lib/api.js";
import { cn } from "../lib/cn.js";
import { useArchiveCanvas, useUnarchiveCanvas } from "../lib/mutations.js";
import { useArchivedCanvases, useCanvases } from "../lib/queries.js";
import type { CanvasesSearch } from "../router.js";
import Onboarding from "./onboarding.js";

const STATE_CHIPS: Array<{ key: keyof CanvasesSearch; label: string }> = [
  { key: "shared", label: "Shared" },
  { key: "protected", label: "Protected" },
  { key: "listed", label: "Listed" },
  { key: "template", label: "Templates" },
  { key: "undeployed", label: "Never deployed" },
];

const CANVASES_SORT_OPTIONS = [
  { value: "updated", label: "Recently updated" },
  { value: "created", label: "Newest" },
  { value: "title", label: "Title A–Z" },
];

/** Active-list row: the usual copy/open, plus a calm one-click Archive (reversible —
 * the canvas moves to the Archived view, restorable anytime). */
function ActiveRow({ canvas }: { canvas: CanvasListItem }) {
  const toast = useToast();
  const archive = useArchiveCanvas(canvas.id);
  const [cloneOpen, setCloneOpen] = useState(false);
  return (
    <CanvasRow
      canvas={canvas}
      actions={
        <>
          <DefaultRowActions canvas={canvas} />
          <Button size="sm" variant="ghost" onClick={() => setCloneOpen(true)}>
            Duplicate
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={archive.isPending}
            onClick={async () => {
              try {
                await archive.mutateAsync();
                toast("Canvas archived");
              } catch (err) {
                toast(err instanceof ApiError ? err.hint : "Couldn't archive", "error");
              }
            }}
          >
            Archive
          </Button>
          <CloneDialog
            open={cloneOpen}
            onClose={() => setCloneOpen(false)}
            sourceId={canvas.id}
            sourceTitle={canvas.title}
            keepsPassword={canvas.hasPassword}
          />
        </>
      }
    />
  );
}

/** Archived-list row: the live URL 404s while archived, so the trailing actions are
 * Unarchive (restore it) + Copy (the slug stays reserved), not Open/Archive. */
function ArchivedRow({ canvas }: { canvas: CanvasListItem }) {
  const toast = useToast();
  const unarchive = useUnarchiveCanvas(canvas.id);
  return (
    <CanvasRow
      canvas={canvas}
      actions={
        <>
          <CopyButton value={canvas.url} label="Copy link" toastMessage="Link copied" />
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
        </>
      }
    />
  );
}

/** Active/Archived lifecycle switch. Archived canvases stay offline-but-kept (files,
 * settings, reserved URL) until restored or deleted — they live one tab away from the
 * active list here, replacing the old standalone Archived nav section. */
function ScopeToggle({
  value,
  onChange,
}: {
  value: "active" | "archived";
  onChange: (s: "active" | "archived") => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Canvas scope"
      className="inline-flex h-9 items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {(["active", "archived"] as const).map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={value === s}
          onClick={() => onChange(s)}
          className={cn(
            "h-8 rounded-md px-3 text-sm font-medium capitalize transition-colors",
            value === s
              ? "bg-surface-sunken text-fg shadow-[var(--shadow-panel)]"
              : "text-muted hover:text-fg",
          )}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

/** Shown when the owner has NO active canvases at all (not merely a filtered-empty
 * view). A brand-new user gets the onboarding first-run page; a user whose canvases
 * are ALL archived gets a pointer to the Archived view instead (showing "get
 * started" would wrongly imply they have nothing). The archived query only fires
 * here — on the empty path — so it costs nothing for users who have active canvases. */
function EmptyHome() {
  const { data: archived } = useArchivedCanvases();
  // Wait for the archived count before choosing, so we don't flash the full
  // onboarding page and then swap it for the archived pointer.
  if (archived === undefined) return <ListSkeleton />;
  if (archived.length > 0) {
    return (
      <EmptyState
        title="No active canvases"
        description={`All your canvases are archived (${archived.length}). Restore one to bring it back live, or create a new canvas.`}
        action={
          <Link to="/" search={{ scope: "archived" }}>
            <Button variant="secondary" size="sm">
              View archived
            </Button>
          </Link>
        }
      />
    );
  }
  return <Onboarding />;
}

/** My-canvases-first (§6.9.1). Server-side filter/search/sort + offset pagination
 * (plan 005), all URL-driven so a filtered view is shareable and back-button-able.
 * Zero active canvases → onboarding, or a pointer to the Archived view when every
 * canvas is archived (see EmptyHome). Archived canvases live in their own view. */
export default function CanvasList() {
  const search = useSearch({ strict: false }) as CanvasesSearch;
  const navigate = useNavigate();

  const q = search.q?.trim() || undefined;
  const sort = search.sort ?? "updated";
  // Lifecycle scope: the active list (default) or the archived set. The attribute
  // chips (Shared/Listed/…) are active-only, so the archived view drops them.
  const archivedView = search.scope === "archived";
  // This route intentionally has no validateSearch (see router.tsx), so `page` can
  // arrive as a non-numeric string from a hand-edited/stale URL. Coerce defensively
  // — a junk `?page=` falls back to 1 rather than letting NaN wedge the pager.
  const rawPage = Number(search.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const offset = (page - 1) * CANVASES_PAGE_SIZE;
  const filtering = archivedView
    ? Boolean(q)
    : Boolean(
        q ||
          search.shared ||
          search.protected ||
          search.listed ||
          search.template ||
          search.undeployed,
      );

  // Local mirror of the search box, debounced into the `q` route param. Seeded on
  // `q` so a shared URL or back-nav populates the field.
  const [text, setText] = useState(q ?? "");
  useEffect(() => {
    setText(q ?? "");
  }, [q]);

  // Typing debounces (300ms) into the URL → refetch; clearing the field applies
  // immediately so the list doesn't stay filtered after the box is emptied.
  useEffect(() => {
    const value = text.trim() || undefined;
    if (value === q) return; // already in sync — no navigation
    if (value === undefined) {
      navigate({ to: "/", search: (prev) => ({ ...prev, q: undefined, page: 1 }) });
      return;
    }
    const id = setTimeout(() => {
      navigate({ to: "/", search: (prev) => ({ ...prev, q: value, page: 1 }) });
    }, 300);
    return () => clearTimeout(id);
  }, [text, q, navigate]);

  const { data, isLoading, isError, isPlaceholderData, refetch } = useCanvases({
    q,
    shared: archivedView ? undefined : search.shared,
    protected: archivedView ? undefined : search.protected,
    listed: archivedView ? undefined : search.listed,
    template: archivedView ? undefined : search.template,
    undeployed: archivedView ? undefined : search.undeployed,
    scope: archivedView ? "archived" : "active",
    sort,
    limit: CANVASES_PAGE_SIZE,
    offset,
  });

  // A refetch that drops below the current page (e.g. a canvas was archived while
  // on the last page) snaps back to page 1 rather than showing an empty page.
  // Gated on !isPlaceholderData so a stale keepPreviousData total can't trigger a
  // spurious reset mid-navigation.
  useEffect(() => {
    if (!isPlaceholderData && data && data.total > 0 && offset >= data.total) {
      navigate({ to: "/", search: (prev) => ({ ...prev, page: 1 }) });
    }
  }, [data, isPlaceholderData, offset, navigate]);

  function toggle(key: keyof CanvasesSearch) {
    const nextOn = !search[key];
    navigate({
      to: "/",
      search: (prev) => ({ ...prev, [key]: nextOn ? true : undefined, page: 1 }),
    });
  }
  function setSort(next: string) {
    navigate({
      to: "/",
      search: (prev) => ({
        ...prev,
        sort: next === "updated" ? undefined : (next as CanvasesSearch["sort"]),
        page: 1,
      }),
    });
  }
  function clearFilters() {
    setText("");
    // Stay in the current scope when clearing attribute/search filters.
    navigate({ to: "/", search: archivedView ? { scope: "archived" } : {} });
  }
  function setScope(next: "active" | "archived") {
    navigate({
      to: "/",
      search: (prev) => ({
        ...prev,
        scope: next === "archived" ? "archived" : undefined,
        // Attribute chips are active-only — drop them when entering the archive.
        ...(next === "archived"
          ? {
              shared: undefined,
              protected: undefined,
              listed: undefined,
              template: undefined,
              undeployed: undefined,
            }
          : {}),
        page: 1,
      }),
    });
  }
  function goToPage(next: number) {
    navigate({ to: "/", search: (prev) => ({ ...prev, page: next }) });
  }

  const total = data?.total ?? 0;
  const items = data?.canvases ?? [];
  const from = total === 0 ? 0 : offset + 1;
  // Clamp to `total` so a stale-data render (keepPreviousData) can't briefly show
  // "Showing 49–49 of 5" before the page snaps back.
  const to = Math.min(offset + items.length, total);
  const hasPrev = page > 1;
  const hasNext = offset + items.length < total;

  // The owner has no active canvases at all (not a filtered-empty view) → the
  // onboarding / all-archived pointer, with no filter controls over it. Keyed on
  // an empty result with no active filter (and a zero total), so a populated page
  // always shows its rows.
  const pristineEmpty =
    !archivedView && Boolean(data) && items.length === 0 && total === 0 && !filtering;

  return (
    <div className="space-y-6">
      {/* The dominant create action lives once, in the top bar (available on every
          page). No duplicate here. */}
      <PageHeader
        title="Your canvases"
        description="Manage drafts, published versions, sharing, and settings from one place."
      />

      {pristineEmpty ? (
        <EmptyHome />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[14rem] flex-1">
              <MagnifyingGlass
                size={16}
                className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-subtle"
                aria-hidden
              />
              <input
                type="search"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Search your canvases"
                aria-label="Search your canvases"
                className="h-9 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
              />
            </div>
            <ScopeToggle value={archivedView ? "archived" : "active"} onChange={setScope} />
            <FilterSelect
              label="Sort your canvases"
              options={CANVASES_SORT_OPTIONS}
              value={sort}
              onValueChange={setSort}
            />
          </div>

          {/* Attribute filters apply to the live set only — hidden in the archive. */}
          {!archivedView && (
            <FilterBar>
              {STATE_CHIPS.map((chip) => (
                <FilterChip
                  key={chip.key}
                  active={search[chip.key] === true}
                  onClick={() => toggle(chip.key)}
                >
                  {chip.label}
                </FilterChip>
              ))}
              {filtering && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="h-9 px-2 text-xs font-medium text-subtle transition-colors hover:text-fg"
                >
                  Clear all
                </button>
              )}
            </FilterBar>
          )}

          {isLoading && <ListSkeleton />}

          {isError && (
            <EmptyState
              title="Couldn't load your canvases"
              description="Something went wrong fetching the list."
              action={
                <Button variant="secondary" size="sm" onClick={() => refetch()}>
                  Try again
                </Button>
              }
            />
          )}

          {data && items.length === 0 && filtering && (
            <EmptyState
              title={
                archivedView ? "No archived canvases match" : "No canvases match these filters"
              }
              description="Try removing a filter, or clear them all to see everything."
              action={
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          )}

          {archivedView && data && items.length === 0 && !filtering && (
            <EmptyState
              title="No archived canvases"
              description="When you archive a canvas it lands here — offline but kept (files, settings, and its reserved URL) until you restore or delete it."
            />
          )}

          {items.length > 0 && (
            <>
              <ul className="space-y-2">
                {items.map((c) =>
                  archivedView ? (
                    <ArchivedRow key={c.id} canvas={c} />
                  ) : (
                    <ActiveRow key={c.id} canvas={c} />
                  ),
                )}
              </ul>

              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-xs text-subtle">
                  Showing {from}–{to} of {total}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!hasPrev}
                    onClick={() => goToPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!hasNext}
                    onClick={() => goToPage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
