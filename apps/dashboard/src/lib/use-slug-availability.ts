import { useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * Slug status (plan 004). `idle` = empty/untouched; `checking` = debounced lookup in
 * flight; the rest are terminal. `taken`/`invalid`/`reserved` are error-ish — the
 * submit action must stay blocked unless the slug is empty or `available`.
 */
export type SlugStatus = "idle" | "checking" | "available" | "taken" | "invalid" | "reserved";

const DEBOUNCE_MS = 400;

/**
 * Debounced availability check for an already-cosmetically-normalized slug. Empty
 * input is `idle`. A network hiccup falls back to `idle` (non-blocking) — the server
 * re-validates authoritatively on submit, so we never hard-fail the UI on a flaky GET.
 */
export function useSlugAvailability(slug: string): SlugStatus {
  const [status, setStatus] = useState<SlugStatus>("idle");

  useEffect(() => {
    if (!slug) {
      setStatus("idle");
      return;
    }
    setStatus("checking");
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await api.slugAvailable(slug);
        if (cancelled) return;
        setStatus(res.available ? "available" : (res.reason ?? "taken"));
      } catch {
        if (!cancelled) setStatus("idle");
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug]);

  return status;
}
