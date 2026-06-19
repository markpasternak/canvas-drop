export type CanvasView = "list" | "grid";

const KEY = "canvas-drop:owner-view";
const DEFAULT_VIEW: CanvasView = "grid";

/**
 * Resolve the owner-list layout with precedence:
 *   URL `?view=` > localStorage > default("grid").
 *
 * A `?view=grid|list` param wins for the visit (shareable/deep-link) and is read
 * straight from the value already in the URL search. With no param, fall back to
 * the per-device stored choice, then the grid default. SSR/private-mode safe.
 *
 * Read this synchronously in the initial render (not a post-mount effect) so the
 * correct layout paints first — no grid↔list flash. Pure client SPA, no SSR.
 */
export function resolveOwnerView(urlView: string | undefined): CanvasView {
  if (urlView === "grid" || urlView === "list") return urlView;
  return readStoredOwnerView() ?? DEFAULT_VIEW;
}

/** Read the persisted layout choice, or `null` when unset/unavailable. */
export function readStoredOwnerView(): CanvasView | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "grid" || stored === "list" ? stored : null;
  } catch {
    return null;
  }
}

/** Best-effort persist of an explicit layout choice (private mode is non-fatal). */
export function persistOwnerView(view: CanvasView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* private mode — non-fatal */
  }
}
