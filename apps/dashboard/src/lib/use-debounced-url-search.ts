import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * Two-way bind a search box to the URL `q` param, debounced. Returns the live input
 * value and its setter (wire straight to a controlled `<input>`).
 *
 * Typing debounces into `q` and resets to page 1; clearing the field applies
 * immediately so the list doesn't stay filtered after the box is emptied. The value
 * is seeded from `q`, so a shared URL or back-navigation repopulates the field.
 *
 * Shared by the Your-canvases, admin canvases, and admin users lists — three lists
 * that previously each carried this identical pair of effects.
 */
export function useDebouncedUrlSearch(
  q: string | undefined,
  to: string,
  delayMs = 300,
): [string, (value: string) => void] {
  const navigate = useNavigate();
  const [text, setText] = useState(q ?? "");

  // Seed/refresh the field from the URL (shared link, back-nav, external clear).
  useEffect(() => {
    setText(q ?? "");
  }, [q]);

  useEffect(() => {
    const value = text.trim() || undefined;
    if (value === q) return; // already in sync — no navigation
    const go = (next: string | undefined) =>
      // biome-ignore lint/suspicious/noExplicitAny: useNavigate is generic over the route tree; this hook is deliberately route-agnostic (these lists read search loosely — see router.tsx).
      navigate({ to, search: (prev: any) => ({ ...prev, q: next, page: 1 }) } as any);
    // Clearing applies immediately; typing debounces.
    if (value === undefined) {
      go(undefined);
      return;
    }
    const id = setTimeout(() => go(value), delayMs);
    return () => clearTimeout(id);
  }, [text, q, to, delayMs, navigate]);

  return [text, setText];
}
