export type GalleryView = "list" | "grid";

const KEY = "canvas-drop:gallery-view";
const DEFAULT_VIEW: GalleryView = "grid";

/**
 * Resolve the gallery layout with the SAME precedence the owner list uses (U8):
 *   URL `?view=` > localStorage > default("grid").
 *
 * Parallel to `owner-view.ts` (separate key so the two surfaces persist
 * independently). A `?view=grid|list` param wins for the visit (shareable); with no
 * param, fall back to the per-device stored choice, then the grid default. Read this
 * synchronously in the initial render so the correct layout paints first — no flash.
 */
export function resolveGalleryView(urlView: string | undefined): GalleryView {
  if (urlView === "grid" || urlView === "list") return urlView;
  return readStoredGalleryView() ?? DEFAULT_VIEW;
}

/** Read the persisted layout choice, or `null` when unset/unavailable. */
export function readStoredGalleryView(): GalleryView | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "grid" || stored === "list" ? stored : null;
  } catch {
    return null;
  }
}

/** Best-effort persist of an explicit layout choice (private mode is non-fatal). */
export function persistGalleryView(view: GalleryView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    /* private mode — non-fatal */
  }
}
