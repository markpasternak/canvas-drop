import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 * SSR/jsdom-safe: defaults to `false` when `matchMedia` is unavailable, and the
 * test setup stubs `matchMedia` to `matches: false` (so components fall to their
 * narrow-viewport branch under test). Used to keep the detail-rail drawer's
 * focus-trap + body-scroll-lock from running once the inline `xl` rail takes over.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query)?.matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
