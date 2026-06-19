/** The shared grid⇄list layout type used by every list surface (owner list, gallery). */
export type LayoutView = "grid" | "list";

export interface ViewPersistence {
  /**
   * Resolve the layout with precedence:
   *   URL `?view=` > localStorage > the surface default.
   *
   * A `?view=grid|list` param wins for the visit (shareable/deep-link) and is read
   * straight from the value already in the URL search. With no param, fall back to
   * the per-device stored choice, then the default. SSR/private-mode safe.
   *
   * Read this synchronously in the initial render (not a post-mount effect) so the
   * correct layout paints first — no grid↔list flash. Pure client SPA, no SSR.
   */
  resolve(urlView: string | undefined): LayoutView;
  /** Read the persisted layout choice, or `null` when unset/unavailable. */
  readStored(): LayoutView | null;
  /** Best-effort persist of an explicit layout choice (private mode is non-fatal). */
  persist(view: LayoutView): void;
}

/**
 * One parameterized factory for the per-surface layout-persistence trio. The owner
 * list and the gallery were structurally identical (same resolve/readStored/persist
 * logic, same URL > localStorage > default precedence) differing only in their
 * localStorage key + default — so they now both wrap this single implementation.
 */
export function createViewPersistence(key: string, fallback: LayoutView): ViewPersistence {
  function readStored(): LayoutView | null {
    if (typeof localStorage === "undefined") return null;
    try {
      const stored = localStorage.getItem(key);
      return stored === "grid" || stored === "list" ? stored : null;
    } catch {
      return null;
    }
  }

  return {
    resolve(urlView) {
      if (urlView === "grid" || urlView === "list") return urlView;
      return readStored() ?? fallback;
    },
    readStored,
    persist(view) {
      try {
        localStorage.setItem(key, view);
      } catch {
        /* private mode — non-fatal */
      }
    },
  };
}
