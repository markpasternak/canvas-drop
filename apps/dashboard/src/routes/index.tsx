import {
  Archive,
  ArrowSquareOut,
  Copy,
  CopySimple,
  MagnifyingGlass,
  Rows,
  SquaresFour,
  Trash,
} from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import { ActionMenu, ActionMenuItem } from "../components/ActionMenu.js";
import { ACCESS_FILTER_OPTIONS } from "../components/Badge.js";
import { BulkActionBar } from "../components/BulkActionBar.js";
import { Button } from "../components/Button.js";
import {
  CanvasCard,
  CanvasListHeader,
  CanvasRow,
  canvasTitle,
  GridSkeleton,
  ListSkeleton,
} from "../components/CanvasList.js";
import { CloneDialog } from "../components/CloneDialog.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { PageHeader } from "../components/Surface.js";
import { useToast } from "../components/Toast.js";
import {
  type AccessRung,
  ApiError,
  CANVASES_PAGE_SIZE,
  type CanvasListItem,
  type CanvasOwnerSummary,
} from "../lib/api.js";
import { useClipboardCopy } from "../lib/clipboard.js";
import { cn } from "../lib/cn.js";
import { useArchiveCanvas, useDeleteCanvas, useUnarchiveCanvas } from "../lib/mutations.js";
import { useCanvases } from "../lib/queries.js";
import { rowPrimaryActionClass } from "../lib/row-styles.js";
import { useDebouncedUrlSearch } from "../lib/use-debounced-url-search.js";
import type { CanvasesSearch } from "../router.js";
import Onboarding from "./onboarding.js";

const EMPTY_SUMMARY: CanvasOwnerSummary = {
  active: 0,
  archived: 0,
  shared: 0,
  protected: 0,
  listed: 0,
  templates: 0,
  neverDeployed: 0,
};

const STATE_CHIPS: Array<{
  key: keyof CanvasesSearch;
  label: string;
  countKey: keyof CanvasOwnerSummary;
}> = [
  { key: "shared", label: "Shared", countKey: "shared" },
  { key: "protected", label: "Protected", countKey: "protected" },
  { key: "listed", label: "Listed", countKey: "listed" },
  { key: "template", label: "Templates", countKey: "templates" },
  { key: "undeployed", label: "Never deployed", countKey: "neverDeployed" },
];

const CANVASES_SORT_OPTIONS = [
  { value: "updated", label: "Recently updated" },
  { value: "created", label: "Newest" },
  { value: "title", label: "Title A–Z" },
];

type CanvasView = "list" | "grid";

interface RowSelectionProps {
  selected: boolean;
  onSelectChange: (next: boolean) => void;
  /** Which presentation to render — the list row or the grid card. */
  view: CanvasView;
}

const MENU_ICON_SIZE = 15;

/** Active-list row: keep the primary work visible and tuck secondary/destructive
 * actions into the shared overflow menu. Never-deployed canvases route to setup
 * instead of pretending there is a useful public link to copy. */
function ActiveRow({
  canvas,
  selected,
  onSelectChange,
  view,
}: { canvas: CanvasListItem } & RowSelectionProps) {
  const toast = useToast();
  const copy = useClipboardCopy();
  const archive = useArchiveCanvas(canvas.id);
  const del = useDeleteCanvas(canvas.id);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const title = canvasTitle(canvas);
  const deployed = canvas.lastDeploy !== null;
  const RowComponent = view === "grid" ? CanvasCard : CanvasRow;

  async function doArchive() {
    try {
      await archive.mutateAsync();
      toast("Canvas archived");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't archive", "error");
    }
  }

  async function doDelete() {
    try {
      await del.mutateAsync();
      setDeleteOpen(false);
      toast("Canvas deleted");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't delete", "error");
    }
  }

  return (
    <RowComponent
      canvas={canvas}
      selectable
      selected={selected}
      onSelectChange={onSelectChange}
      actions={
        <>
          {deployed ? (
            <a
              href={canvas.url}
              target="_blank"
              rel="noreferrer"
              className={rowPrimaryActionClass}
              aria-label={`Open ${title}`}
            >
              Open
              <ArrowSquareOut size={13} weight="bold" aria-hidden />
            </a>
          ) : (
            <Link
              to="/canvases/$id/editor"
              params={{ id: canvas.id }}
              className={rowPrimaryActionClass}
              aria-label={`Continue setup for ${title}`}
            >
              Continue setup
            </Link>
          )}
          <ActionMenu label={`More actions for ${title}`}>
            {deployed && (
              <ActionMenuItem
                icon={<Copy size={MENU_ICON_SIZE} aria-hidden />}
                onSelect={() => copy(canvas.url, "Link copied")}
              >
                Copy link
              </ActionMenuItem>
            )}
            <ActionMenuItem
              icon={<CopySimple size={MENU_ICON_SIZE} aria-hidden />}
              onSelect={() => setCloneOpen(true)}
            >
              Duplicate
            </ActionMenuItem>
            <ActionMenuItem
              icon={<Archive size={MENU_ICON_SIZE} aria-hidden />}
              onSelect={doArchive}
            >
              Archive
            </ActionMenuItem>
            <ActionMenuItem
              danger
              icon={<Trash size={MENU_ICON_SIZE} aria-hidden />}
              onSelect={() => setDeleteOpen(true)}
            >
              Delete
            </ActionMenuItem>
          </ActionMenu>
          <CloneDialog
            open={cloneOpen}
            onClose={() => setCloneOpen(false)}
            sourceId={canvas.id}
            sourceTitle={canvas.title}
            keepsPassword={canvas.hasPassword}
          />
          <ConfirmDialog
            open={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            onConfirm={doDelete}
            title={`Delete “${title}”?`}
            actionLabel="Delete canvas"
            destructive
            holdToConfirm
            loading={del.isPending}
          >
            It goes offline and leaves your list. Recoverable for 30 days, then purged. Hold the
            button to confirm.
          </ConfirmDialog>
        </>
      }
    />
  );
}

/** Archived-list row: the live URL 404s while archived, so the trailing actions are
 * Unarchive (restore it) + Copy (the slug stays reserved) / Delete, not Open/Archive. */
function ArchivedRow({
  canvas,
  selected,
  onSelectChange,
  view,
}: { canvas: CanvasListItem } & RowSelectionProps) {
  const toast = useToast();
  const copy = useClipboardCopy();
  const unarchive = useUnarchiveCanvas(canvas.id);
  const del = useDeleteCanvas(canvas.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const title = canvasTitle(canvas);
  const RowComponent = view === "grid" ? CanvasCard : CanvasRow;

  async function doDelete() {
    try {
      await del.mutateAsync();
      setDeleteOpen(false);
      toast("Canvas deleted");
    } catch (err) {
      toast(err instanceof ApiError ? err.hint : "Couldn't delete", "error");
    }
  }

  return (
    <RowComponent
      canvas={canvas}
      selectable
      selected={selected}
      onSelectChange={onSelectChange}
      actions={
        <>
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
            Restore
          </Button>
          <ActionMenu label={`More actions for ${title}`}>
            <ActionMenuItem
              icon={<Copy size={MENU_ICON_SIZE} aria-hidden />}
              onSelect={() => copy(canvas.url, "Link copied")}
            >
              Copy reserved URL
            </ActionMenuItem>
            <ActionMenuItem
              danger
              icon={<Trash size={MENU_ICON_SIZE} aria-hidden />}
              onSelect={() => setDeleteOpen(true)}
            >
              Delete
            </ActionMenuItem>
          </ActionMenu>
          <ConfirmDialog
            open={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            onConfirm={doDelete}
            title={`Delete “${title}”?`}
            actionLabel="Delete canvas"
            destructive
            holdToConfirm
            loading={del.isPending}
          >
            It leaves your list for good after 30 days. Recoverable until then. Hold the button to
            confirm.
          </ConfirmDialog>
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
  summary,
}: {
  value: "active" | "archived";
  onChange: (s: "active" | "archived") => void;
  summary: CanvasOwnerSummary;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a button-group filter (role=group + aria-label), not a form fieldset
    <div
      role="group"
      aria-label="Canvas scope"
      className="inline-flex h-9 items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {(["active", "archived"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={value === s}
          onClick={() => onChange(s)}
          className={cn(
            "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors",
            value === s
              ? "bg-surface-sunken text-fg shadow-[var(--shadow-panel)]"
              : "text-muted hover:text-fg",
          )}
        >
          <span className="capitalize">{s}</span>
          <span className="ml-1.5 text-xs text-subtle">{summary[s]}</span>
        </button>
      ))}
    </div>
  );
}

/** List ⇄ grid layout switch. Mirrors the segmented styling of the scope toggle;
 *  the choice lives in the URL (`?view=grid`) so a layout is shareable + sticky. */
function ViewToggle({ value, onChange }: { value: CanvasView; onChange: (v: CanvasView) => void }) {
  const options = [
    { v: "list", label: "List view", Icon: Rows },
    { v: "grid", label: "Grid view", Icon: SquaresFour },
  ] as const;
  return (
    <div
      role="tablist"
      aria-label="Canvas layout"
      className="inline-flex h-9 items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map(({ v, label, Icon }) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          aria-label={label}
          title={label}
          onClick={() => onChange(v)}
          className={cn(
            "inline-flex h-8 items-center rounded-md px-2.5 transition-colors",
            value === v
              ? "bg-surface-sunken text-fg shadow-[var(--shadow-panel)]"
              : "text-muted hover:text-fg",
          )}
        >
          <Icon size={16} weight={value === v ? "fill" : "regular"} aria-hidden />
        </button>
      ))}
    </div>
  );
}

function SummaryStrip({
  summary,
  archivedView,
}: {
  summary: CanvasOwnerSummary;
  archivedView: boolean;
}) {
  const items = [
    { label: "Active", value: summary.active, active: !archivedView },
    { label: "Archived", value: summary.archived, active: archivedView },
    { label: "Templates", value: summary.templates },
    { label: "Never deployed", value: summary.neverDeployed },
    { label: "Protected", value: summary.protected },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "bg-surface px-3 py-2",
            index === items.length - 1 && "col-span-2 sm:col-span-1",
            item.active && "bg-accent-subtle text-accent",
          )}
        >
          <dt className="text-[0.6875rem] font-medium text-subtle">{item.label}</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Shown when the owner has NO active canvases at all (not merely a filtered-empty
 * view). A brand-new user gets the onboarding first-run page; a user whose canvases
 * are ALL archived gets a pointer to the Archived view instead (showing "get
 * started" would wrongly imply they have nothing). The archived count comes from the
 * list response's inventory summary — already loaded here — so no extra request fires. */
function EmptyHome({ archivedCount }: { archivedCount: number }) {
  if (archivedCount > 0) {
    return (
      <EmptyState
        title="No active canvases"
        description={`All your canvases are archived (${archivedCount}). Restore one to bring it back live, or create a new canvas.`}
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
  const view: CanvasView = search.view === "grid" ? "grid" : "list";
  // Lifecycle scope: the active list (default) or the archived set. The attribute
  // chips (Shared/Listed/…) are active-only, so the archived view drops them.
  const archivedView = search.scope === "archived";
  // The access-rung filter, like the attribute chips, applies to the live set only.
  const access = archivedView ? undefined : search.access;
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
          access ||
          search.shared ||
          search.protected ||
          search.listed ||
          search.template ||
          search.undeployed,
      );

  // Search box ⇆ URL `q`, debounced (shared with the admin canvases/users lists).
  const [text, setText] = useDebouncedUrlSearch(q, "/");

  const { data, isLoading, isError, isPlaceholderData, refetch } = useCanvases({
    q,
    access,
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

  // Bulk selection (Your-canvases multi-edit). Selection is per-view: any change of
  // page, scope, search, or filter clears it, since selecting then navigating to a
  // different result set would act on ids the user can no longer see. Keyed on the
  // scalar filter inputs so it resets exactly when the visible set can change.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on any filter/scope/page change, not on `selected` identity.
  useEffect(() => {
    setSelected(new Set());
  }, [
    archivedView,
    page,
    q,
    access,
    sort,
    search.shared,
    search.protected,
    search.listed,
    search.template,
    search.undeployed,
  ]);

  function toggleSelected(id: string, next: boolean) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

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
  function setView(next: CanvasView) {
    // Layout is a pure view concern — preserve filters/scope/page, just flip `view`.
    navigate({
      to: "/",
      search: (prev) => ({ ...prev, view: next === "grid" ? "grid" : undefined }),
    });
  }
  function setAccess(next: string) {
    navigate({
      to: "/",
      search: (prev) => ({
        ...prev,
        access: next === "all" ? undefined : (next as AccessRung),
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
        // Attribute chips + the access filter are active-only — drop on entering the archive.
        ...(next === "archived"
          ? {
              access: undefined,
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
  const summary = data?.summary ?? EMPTY_SUMMARY;
  const activeChipKeys = archivedView
    ? []
    : STATE_CHIPS.filter((chip) => search[chip.key] === true).map((chip) => chip.key);
  const lastActiveChipKey = activeChipKeys.at(-1);
  const from = total === 0 ? 0 : offset + 1;
  // Clamp to `total` so a stale-data render (keepPreviousData) can't briefly show
  // "Showing 49–49 of 5" before the page snaps back.
  const to = Math.min(offset + items.length, total);
  const hasPrev = page > 1;
  const hasNext = offset + items.length < total;
  // Select-all operates on the visible page only (selection is per-view).
  const selectedOnPage = items.filter((c) => selected.has(c.id));
  const allSelected = items.length > 0 && selectedOnPage.length === items.length;
  const someSelected = selectedOnPage.length > 0 && !allSelected;
  function toggleSelectAll(next: boolean) {
    setSelected(next ? new Set(items.map((c) => c.id)) : new Set());
  }
  const resultLabel =
    total === 0
      ? archivedView
        ? "No archived canvases"
        : "No canvases"
      : `Showing ${from}–${to} of ${total}`;

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
        <EmptyHome archivedCount={summary.archived} />
      ) : (
        <>
          <SummaryStrip summary={summary} archivedView={archivedView} />

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
            <ScopeToggle
              value={archivedView ? "archived" : "active"}
              onChange={setScope}
              summary={summary}
            />
            {!archivedView && (
              <FilterSelect
                label="Filter by access"
                options={ACCESS_FILTER_OPTIONS}
                value={access ?? "all"}
                onValueChange={setAccess}
              />
            )}
            <FilterSelect
              label="Sort your canvases"
              options={CANVASES_SORT_OPTIONS}
              value={sort}
              onValueChange={setSort}
            />
            <ViewToggle value={view} onChange={setView} />
          </div>

          {/* Attribute filters apply to the live set only — hidden in the archive. */}
          {!archivedView && (
            <FilterBar>
              {STATE_CHIPS.map((chip, index) => (
                <Fragment key={chip.key}>
                  <FilterChip active={search[chip.key] === true} onClick={() => toggle(chip.key)}>
                    <span>{chip.label}</span>
                    <span className="ml-2 text-xs tabular-nums text-subtle" aria-hidden>
                      {summary[chip.countKey]}
                    </span>
                  </FilterChip>
                  {filtering &&
                    (chip.key === lastActiveChipKey ||
                      (lastActiveChipKey === undefined && index === STATE_CHIPS.length - 1)) && (
                      <button
                        type="button"
                        onClick={clearFilters}
                        className="h-9 px-2 text-xs font-medium text-subtle transition-colors hover:text-fg"
                      >
                        Clear all
                      </button>
                    )}
                </Fragment>
              ))}
            </FilterBar>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-subtle">{isLoading ? "Loading canvases..." : resultLabel}</p>
            {archivedView && filtering && (
              <button
                type="button"
                onClick={clearFilters}
                className="h-8 rounded-md px-2 text-xs font-medium text-subtle transition-colors hover:bg-surface-hover hover:text-fg"
              >
                Clear all
              </button>
            )}
          </div>

          {isLoading && (view === "grid" ? <GridSkeleton /> : <ListSkeleton />)}

          {isError && (
            <EmptyState
              title="Couldn't load your canvases"
              description="We couldn't reach your canvases just now. Try again."
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
              {view === "grid" ? (
                <div className="space-y-3">
                  <label className="flex w-fit cursor-pointer items-center gap-2 text-xs font-medium text-muted">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={(event) => toggleSelectAll(event.target.checked)}
                      aria-label="Select all canvases on this page"
                      className="size-4 cursor-pointer accent-accent"
                    />
                    Select all
                  </label>
                  <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {items.map((c) =>
                      archivedView ? (
                        <ArchivedRow
                          key={c.id}
                          canvas={c}
                          view={view}
                          selected={selected.has(c.id)}
                          onSelectChange={(next) => toggleSelected(c.id, next)}
                        />
                      ) : (
                        <ActiveRow
                          key={c.id}
                          canvas={c}
                          view={view}
                          selected={selected.has(c.id)}
                          onSelectChange={(next) => toggleSelected(c.id, next)}
                        />
                      ),
                    )}
                  </ul>
                </div>
              ) : (
                <div className="space-y-2 lg:space-y-0 lg:rounded-lg lg:border lg:border-border lg:bg-surface">
                  <CanvasListHeader
                    selectable
                    allSelected={allSelected}
                    someSelected={someSelected}
                    onSelectAll={toggleSelectAll}
                  />
                  <ul className="space-y-2 lg:space-y-0 lg:divide-y lg:divide-border">
                    {items.map((c) =>
                      archivedView ? (
                        <ArchivedRow
                          key={c.id}
                          canvas={c}
                          view={view}
                          selected={selected.has(c.id)}
                          onSelectChange={(next) => toggleSelected(c.id, next)}
                        />
                      ) : (
                        <ActiveRow
                          key={c.id}
                          canvas={c}
                          view={view}
                          selected={selected.has(c.id)}
                          onSelectChange={(next) => toggleSelected(c.id, next)}
                        />
                      ),
                    )}
                  </ul>
                </div>
              )}

              {selected.size > 0 && (
                <BulkActionBar
                  selectedIds={[...selected]}
                  scope={archivedView ? "archived" : "active"}
                  onClear={() => setSelected(new Set())}
                  onResult={(result) => setSelected(new Set(result.failed))}
                />
              )}

              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-xs text-subtle">{resultLabel}</p>
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
