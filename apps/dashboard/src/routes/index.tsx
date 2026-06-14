import { MagnifyingGlass } from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button.js";
import { CanvasRow, DefaultRowActions, ListSkeleton } from "../components/CanvasList.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { PageHeader } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import { ApiError, type CanvasListItem } from "../lib/api.js";
import { useArchiveCanvas } from "../lib/mutations.js";
import { useArchivedCanvases, useCanvases } from "../lib/queries.js";
import type { CanvasesSearch } from "../router.js";
import Onboarding from "./onboarding.js";

/** Client-side filter + sort over the already-loaded owned list (plan 004). All
 *  filter inputs are present on `CanvasListItem`, so no server call is added. */
function filterAndSort(list: CanvasListItem[], s: CanvasesSearch): CanvasListItem[] {
  const q = s.q?.trim().toLowerCase();
  const out = list.filter((c) => {
    if (s.shared && !c.shared) return false;
    if (s.protected && !c.hasPassword) return false;
    if (s.listed && !c.galleryListed) return false;
    if (s.template && !c.galleryTemplatable) return false;
    if (s.undeployed && c.lastDeploy !== null) return false;
    if (q && !`${c.title} ${c.slug}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const sort = s.sort ?? "updated";
  return out.sort((a, b) => {
    if (sort === "title") return (a.title || a.slug).localeCompare(b.title || b.slug);
    if (sort === "created") return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt; // "updated" — the default
  });
}

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

/** Shown when the active list is empty. A brand-new user gets the onboarding
 * first-run page; a user whose canvases are ALL archived gets a pointer to the
 * Archived view instead (showing "get started" would wrongly imply they have
 * nothing). The archived query only fires here — on the empty path — so it costs
 * nothing for users who have active canvases. */
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
          <Link to="/archived">
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

/** My-canvases-first (§6.9.1). Zero canvases → onboarding, or a pointer to the
 * Archived view when every canvas is archived (see EmptyHome).
 * Archived canvases live in their own view (/archived) and are excluded here. */
export default function CanvasList() {
  const { data, isLoading, isError, refetch } = useCanvases();
  const search = useSearch({ strict: false }) as CanvasesSearch;
  const navigate = useNavigate();

  const sort = search.sort ?? "updated";
  const filtering = Boolean(
    search.q ||
      search.shared ||
      search.protected ||
      search.listed ||
      search.template ||
      search.undeployed,
  );

  // Local mirror of the search box (seeded so a shared URL / back-nav populates the
  // field). Resync when the param changes externally, e.g. back-button or clear-all.
  const [text, setText] = useState(search.q ?? "");
  useEffect(() => {
    setText(search.q ?? "");
  }, [search.q]);

  const filtered = useMemo(() => (data ? filterAndSort(data, search) : []), [data, search]);

  function toggle(key: keyof CanvasesSearch) {
    // Read current state from the coerced `search` (not the loosely-typed updater
    // arg) so toggling is type-safe on the un-validated index route.
    const nextOn = !search[key];
    navigate({
      to: "/",
      search: (prev) => ({ ...prev, [key]: nextOn ? true : undefined }),
    });
  }
  function setSort(next: string) {
    navigate({
      to: "/",
      search: (prev) => ({
        ...prev,
        sort: next === "updated" ? undefined : (next as CanvasesSearch["sort"]),
      }),
    });
  }
  function setQ(next: string) {
    setText(next);
    const value = next.trim() || undefined;
    // Client-side filter, so apply immediately; `replace` keeps per-keystroke URL
    // writes from stacking the browser history.
    navigate({ to: "/", search: (prev) => ({ ...prev, q: value }), replace: true });
  }
  function clearFilters() {
    setText("");
    navigate({ to: "/", search: {} });
  }

  return (
    <div className="space-y-6">
      {/* The dominant create action lives once, in the top bar (available on every
          page). No duplicate here. */}
      <PageHeader
        title="Your canvases"
        description="Manage drafts, published versions, sharing, and settings from one place."
      />

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

      {/* Onboarding / all-archived pointer only when the owner truly has no canvases
          — never when a filter merely emptied the view. */}
      {data && data.length === 0 && <EmptyHome />}

      {data && data.length > 0 && (
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
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search your canvases"
                aria-label="Search your canvases"
                className="h-9 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
              />
            </div>
            <FilterSelect
              label="Sort your canvases"
              options={CANVASES_SORT_OPTIONS}
              value={sort}
              onValueChange={setSort}
            />
          </div>

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

          {filtered.length > 0 ? (
            <ul className="space-y-2">
              {filtered.map((c) => (
                <ActiveRow key={c.id} canvas={c} />
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No canvases match these filters"
              description="Try removing a filter, or clear them all to see everything."
              action={
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          )}
        </>
      )}
    </div>
  );
}
