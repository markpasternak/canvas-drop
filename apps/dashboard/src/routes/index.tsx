import {
  Archive,
  ArrowSquareOut,
  Copy,
  CopySimple,
  Rows,
  SquaresFour,
  Trash,
} from "@phosphor-icons/react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
import { type Concept, conceptColor, conceptIcon } from "../components/concept-colors.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterChip, FilterSelect } from "../components/Filters.js";
import { SearchInput } from "../components/SearchInput.js";
import { SegmentedControl } from "../components/SegmentedControl.js";
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
import { useMediaQuery } from "../lib/use-media-query.js";
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
  concept: Concept;
}> = [
  { key: "shared", label: "Shared", countKey: "shared", concept: "shared" },
  { key: "protected", label: "Protected", countKey: "protected", concept: "protected" },
  { key: "listed", label: "Listed", countKey: "listed", concept: "listed" },
  { key: "template", label: "Templates", countKey: "templates", concept: "templates" },
  {
    key: "undeployed",
    label: "Never deployed",
    countKey: "neverDeployed",
    concept: "neverDeployed",
  },
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
  /** Focus this canvas in the detail rail (body click / Enter); distinct from the
   *  multi-select checkbox above. */
  onActivate: () => void;
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
  onActivate,
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
          {/* The whole-row body click navigates to the canvas detail page. "Details"
              is the explicit affordance for the inline detail rail (sets ?selected) —
              same button shape as Open. */}
          <button
            type="button"
            onClick={onActivate}
            className={rowPrimaryActionClass}
            aria-label={`Show details for ${title}`}
          >
            Details
          </button>
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
  onActivate,
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
          {/* Body click navigates to the canvas detail page; "Details" opens the rail. */}
          <button
            type="button"
            onClick={onActivate}
            className={rowPrimaryActionClass}
            aria-label={`Show details for ${title}`}
          >
            Details
          </button>
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
    <SegmentedControl
      aria-label="Canvas scope"
      value={value}
      onChange={onChange}
      items={[
        { value: "active", label: "Active", count: summary.active },
        { value: "archived", label: "Archived", count: summary.archived },
      ]}
    />
  );
}

/** List ⇄ grid layout switch. Mirrors the segmented styling of the scope toggle;
 *  the choice lives in the URL (`?view=grid`) so a layout is shareable + sticky. */
function ViewToggle({ value, onChange }: { value: CanvasView; onChange: (v: CanvasView) => void }) {
  return (
    <SegmentedControl
      aria-label="Canvas layout"
      iconOnly
      value={value}
      onChange={onChange}
      items={[
        { value: "list", label: "List view", icon: Rows },
        { value: "grid", label: "Grid view", icon: SquaresFour },
      ]}
    />
  );
}

function SummaryStrip({
  summary,
  archivedView,
}: {
  summary: CanvasOwnerSummary;
  archivedView: boolean;
}) {
  const items: Array<{
    label: string;
    value: number;
    concept: Concept;
    active?: boolean;
  }> = [
    { label: "Active", value: summary.active, concept: "active", active: !archivedView },
    { label: "Archived", value: summary.archived, concept: "archived", active: archivedView },
    { label: "Templates", value: summary.templates, concept: "templates" },
    { label: "Never deployed", value: summary.neverDeployed, concept: "neverDeployed" },
    { label: "Protected", value: summary.protected, concept: "protected" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
      {items.map((item, index) => {
        // Each stat is a per-concept accent-coloured icon tile + a label + an
        // expressive number. The tile carries the colour (the concept's -subtle
        // wash behind the concept-coloured glyph, both from the shared concept
        // map); the surface itself stays calm warm-paper/deep-navy. The active
        // lifecycle scope still gets its accent wash so the current scope stands
        // out. Icon + colour are read from one source, so they can't drift.
        const color = conceptColor(item.concept);
        const Icon = conceptIcon(item.concept);
        return (
          <div
            key={item.label}
            data-concept={item.concept}
            className={cn(
              "flex items-center gap-2.5 bg-surface px-3 py-2.5",
              index === items.length - 1 && "col-span-2 sm:col-span-1",
              item.active && "bg-accent-subtle",
            )}
          >
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                color.bg,
                color.text,
              )}
              aria-hidden
            >
              <Icon size={18} weight="duotone" />
            </span>
            <div className="min-w-0">
              <dt className="truncate text-[0.6875rem] font-medium uppercase tracking-wide text-subtle">
                {item.label}
              </dt>
              <dd
                className={cn(
                  "text-2xl font-bold leading-none tracking-tight tabular-nums text-fg",
                  item.active && "text-accent",
                )}
              >
                {item.value}
              </dd>
            </div>
          </div>
        );
      })}
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
  // At `xl` the detail rail is the inline sticky column; below it, the slide-in
  // drawer. Tracking the breakpoint here keeps the drawer's focus-trap +
  // body-scroll-lock from firing while the inline rail is the one on screen.
  const isXl = useMediaQuery("(min-width: 1280px)");

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
  // The detail-rail focus (plan rebrand P4): a single "focused" canvas in the URL
  // (`?selected=<id>`), distinct from the multi-select checkbox set. Patch search,
  // preserving view/scope/filters/page so a focus survives every other axis.
  function setFocused(id: string | undefined) {
    navigate({ to: "/", search: (prev) => ({ ...prev, selected: id }) });
  }
  // Duplicate from the detail rail (P4 / U4): opens the SAME shared CloneDialog the
  // rows use, for the focused canvas. Any owned canvas can be cloned (the rows clone
  // unconditionally), so this is offered for every focused canvas — not gated on
  // templatable the way the gallery is (that gate is for OTHER people's canvases).
  // (State + the "reset on focus change" effect live below `focusedId`.)

  const total = data?.total ?? 0;
  const items = data?.canvases ?? [];
  const summary = data?.summary ?? EMPTY_SUMMARY;
  // The focused canvas for the detail rail (U3 consumes this). Validate against the
  // visible page so a stale/unknown `?selected=` is simply ignored rather than
  // pointing the rail at a canvas that isn't here.
  const focusedId =
    typeof search.selected === "string" && items.some((c) => c.id === search.selected)
      ? search.selected
      : undefined;
  // The focused canvas object for the detail rail (U3), looked up from the
  // already-loaded page items — no extra request. `null` → DetailPanel's empty state.
  const focusedCanvas = focusedId ? (items.find((c) => c.id === focusedId) ?? null) : null;
  // Duplicate from the detail rail (P4 / U4): opens the SAME shared CloneDialog the
  // rows use, for the focused canvas. Reset whenever the focus changes (or clears)
  // so the dialog never points at a canvas other than the one it was opened for.
  const [cloneOpen, setCloneOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on focus change, not on `cloneOpen`.
  useEffect(() => {
    setCloneOpen(false);
  }, [focusedId]);
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

  // Whether to render the inline (xl) detail rail: only when a canvas is focused
  // AND we're showing the library (the pristine onboarding view has no rail). When
  // nothing is focused the library spans full width and the page looks as it did
  // before the rail existed (the grid collapses to a single column).
  const showRail = !pristineEmpty && focusedCanvas !== null;

  // Inline rail (xl) dismissal: unlike the drawer it has no scrim, so wire its own
  // outside-click + Escape to clear the focus. An outside click clears only when it
  // lands on truly-empty space — NOT on the rail itself, NOT on a canvas row/card
  // (clicking another row reselects via its own handler), and NOT on an interactive
  // control (links/buttons/menus keep their behavior). Escape always clears. Gated on
  // the inline rail being the one on screen (`isXl`) so it never fights the drawer's
  // own Escape/scrim handling below xl.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setFocused only delegates to the identity-stable router navigate, so the listener closure stays correct across focus changes; re-bind only when the inline rail toggles.
  useEffect(() => {
    if (!showRail || !isXl) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      // Inside the rail, on a row/card, or on any interactive control → leave the
      // selection alone (those have their own click semantics).
      if (
        target.closest("[data-detail-rail]") ||
        target.closest("[data-canvas-item]") ||
        // Also skip an overlay's own dismiss backdrop (a dialog/drawer opened FROM
        // the rail, e.g. Duplicate): its scrim is role="presentation", so clicking
        // it to close the dialog must not also clear the rail focus underneath.
        target.closest(
          "a, button, input, select, textarea, summary, [role='button'], [role='dialog'], [role='presentation']",
        )
      ) {
        return;
      }
      setFocused(undefined);
    }
    function onKey(e: KeyboardEvent) {
      // Yield to any higher-level overlay that already handled Escape (e.g. the
      // account menu calls preventDefault on its own Escape) so closing a popover
      // doesn't also clear the rail selection underneath.
      if (e.key === "Escape" && !e.defaultPrevented) setFocused(undefined);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showRail, isXl]);

  return (
    // The focused canvas (detail rail, U3) rides as a data attribute so route tests
    // (and U1) can assert the focus without depending on the rail's DOM.
    <div className="space-y-6" data-selected-canvas={focusedId ?? undefined}>
      {/* The dominant create action lives once, in the navigation rail (available
          on every page). No duplicate here. */}
      <PageHeader
        title="Your canvases"
        description="Manage drafts, published versions, sharing, and settings from one place."
      />

      {/* Two-pane layout (U3): the library + an additive right rail. At `xl` the rail
          is an inline sticky column (~340px) shown only when a canvas is focused;
          below `xl` it becomes the slide-in DetailDrawer further down. When nothing
          is focused the library is full width and nothing else changes. */}
      <div
        className={cn(
          "gap-6",
          showRail ? "xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start" : "",
        )}
      >
        <div className="min-w-0 space-y-6">
          {pristineEmpty ? (
            <EmptyHome archivedCount={summary.archived} />
          ) : (
            <>
              <SummaryStrip summary={summary} archivedView={archivedView} />

              <div className="flex flex-wrap items-center gap-3">
                <SearchInput
                  value={text}
                  onChange={setText}
                  placeholder="Search your canvases"
                  aria-label="Search your canvases"
                />
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

              {/* Attribute filters apply to the live set only — hidden in the archive.
                  "Clear all" trails the whole chip row (only while a filter is active),
                  not wedged between two chips. */}
              {!archivedView && (
                <FilterBar>
                  {STATE_CHIPS.map((chip) => (
                    <FilterChip
                      key={chip.key}
                      active={search[chip.key] === true}
                      onClick={() => toggle(chip.key)}
                      dotClassName={conceptColor(chip.concept).dot}
                    >
                      <span>{chip.label}</span>
                      <span className="text-xs tabular-nums text-subtle" aria-hidden>
                        {summary[chip.countKey]}
                      </span>
                    </FilterChip>
                  ))}
                  {filtering && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="ml-1 h-9 px-2 text-xs font-medium text-subtle transition-colors hover:text-fg"
                    >
                      Clear all
                    </button>
                  )}
                </FilterBar>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-subtle">
                  {isLoading ? "Loading canvases..." : resultLabel}
                </p>
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
                      <ul
                        className={cn(
                          "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
                          // When the inline detail rail is showing at xl (alongside
                          // the 15rem left nav), a 4-col grid crushes cards to ~140px
                          // on 1280–1440px. Cap at 3 cols while the rail occupies the
                          // row; only go to 4 when the library spans full width.
                          !showRail && "xl:grid-cols-4",
                        )}
                      >
                        {items.map((c) =>
                          archivedView ? (
                            <ArchivedRow
                              key={c.id}
                              canvas={c}
                              view={view}
                              selected={selected.has(c.id)}
                              onSelectChange={(next) => toggleSelected(c.id, next)}
                              onActivate={() => setFocused(c.id)}
                            />
                          ) : (
                            <ActiveRow
                              key={c.id}
                              canvas={c}
                              view={view}
                              selected={selected.has(c.id)}
                              onSelectChange={(next) => toggleSelected(c.id, next)}
                              onActivate={() => setFocused(c.id)}
                            />
                          ),
                        )}
                      </ul>
                    </div>
                  ) : (
                    // Flat Lovable-style list: no surrounding card/border/background —
                    // a quiet hairline column header over rows divided by hairlines on
                    // the plain page background.
                    <div className="space-y-2 lg:space-y-0">
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
                              onActivate={() => setFocused(c.id)}
                            />
                          ) : (
                            <ActiveRow
                              key={c.id}
                              canvas={c}
                              view={view}
                              selected={selected.has(c.id)}
                              onSelectChange={(next) => toggleSelected(c.id, next)}
                              onActivate={() => setFocused(c.id)}
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

        {/* Inline rail — `xl` and up only; the drawer below covers narrower widths.
            Pinned full-height (sticky + viewport height) so it stays in place while the
            library scrolls, with its own internal scroll for long detail. A flat
            hairline divides it from the library (no boxy card — the DetailPanel is
            chrome-less). Gated on `isXl` (not just a `hidden xl:block` CSS class) so
            below `xl` only the drawer renders the DetailPanel — one details region. */}
        {showRail && isXl && (
          <div
            className="sticky top-6 hidden h-[calc(100dvh-3rem)] border-border border-l pl-6 xl:block"
            data-detail-rail
          >
            <DetailPanel canvas={focusedCanvas} onDuplicate={() => setCloneOpen(true)} />
          </div>
        )}
      </div>

      {/* Slide-in drawer — below `xl`. Opens when a canvas is focused; Escape, the
          scrim, or the close button all clear the selection. Hidden at `xl` (the
          inline rail takes over) via the drawer's own `xl:hidden`. */}
      <DetailDrawer
        open={focusedCanvas !== null && !isXl}
        onClose={() => setFocused(undefined)}
        label="Canvas details"
      >
        <DetailPanel canvas={focusedCanvas} onDuplicate={() => setCloneOpen(true)} />
      </DetailDrawer>

      {/* One shared CloneDialog for the rail's Duplicate (both the inline + drawer
          DetailPanel route through it). Mounted once at the route level — keyed to
          the focused canvas — so the inline and drawer instances don't each carry a
          dialog. Confirming clones + navigates to the new canvas's editor. */}
      {focusedCanvas && (
        <CloneDialog
          open={cloneOpen}
          onClose={() => setCloneOpen(false)}
          sourceId={focusedCanvas.id}
          sourceTitle={focusedCanvas.title}
          keepsPassword={focusedCanvas.hasPassword}
        />
      )}
    </div>
  );
}
