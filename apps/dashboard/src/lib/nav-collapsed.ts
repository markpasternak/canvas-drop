import { useCallback, useState } from "react";

const KEY = "canvas-drop-nav-collapsed";

/** Read the persisted collapse choice. Defaults to expanded (false). SSR/private-mode safe. */
function read(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Best-effort write of the collapse choice (private mode is non-fatal). */
function persist(v: boolean): void {
  try {
    if (v) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — non-fatal */
  }
}

/**
 * The lg+ left-rail collapse state, persisted in localStorage (mirrors the
 * theme persistence in {@link ../lib/theme}). Default = expanded. The choice
 * survives reloads; writes are best-effort (private-mode safe).
 */
export function useNavCollapsed(): {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
} {
  const [collapsed, setCollapsedState] = useState<boolean>(read);

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v);
    persist(v);
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      persist(next);
      return next;
    });
  }, []);

  return { collapsed, toggle, setCollapsed };
}
