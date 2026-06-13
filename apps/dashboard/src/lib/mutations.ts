import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Canvas, type CanvasSettings } from "./api.js";
import { keys } from "./queries.js";

/**
 * Settings update — OPTIMISTIC (reversible toggles). Snapshots the canvas, applies
 * the patch to the cache immediately, and rolls back on error. Password is a patch
 * field too, but the Settings UI awaits it (KTD-5) — optimism here is safe because
 * we never echo the password, only flip `hasPassword`.
 */
export function useUpdateSettings(id: string) {
  const qc = useQueryClient();
  return useMutation({
    // Serialize settings mutations for this canvas (TanStack `scope`) so rapid
    // overlapping toggles can't snapshot each other's optimistic state and roll
    // back to a stale value — each runs against the prior one's settled cache.
    scope: { id: `settings-${id}` },
    mutationFn: (patch: CanvasSettings) => api.updateSettings(id, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: keys.canvas(id) });
      const prev = qc.getQueryData<Canvas>(keys.canvas(id));
      if (prev) {
        const optimistic: Canvas = { ...prev };
        if (patch.title !== undefined) optimistic.title = patch.title;
        if (patch.description !== undefined) optimistic.description = patch.description;
        if (patch.shared !== undefined) optimistic.shared = patch.shared;
        if (patch.sharedExpiresAt !== undefined) optimistic.sharedExpiresAt = patch.sharedExpiresAt;
        if (patch.spaFallback !== undefined) optimistic.spaFallback = patch.spaFallback;
        if (patch.galleryListed !== undefined) optimistic.galleryListed = patch.galleryListed;
        if (patch.password !== undefined) optimistic.hasPassword = patch.password !== null;
        qc.setQueryData(keys.canvas(id), optimistic);
      }
      return { prev };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.canvas(id), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.canvas(id) });
      qc.invalidateQueries({ queryKey: keys.canvases });
    },
  });
}

/** Rollback — await + invalidate (not optimistic; changes the live canvas). */
export function useRollback(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => api.rollback(id, version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.canvas(id) });
      qc.invalidateQueries({ queryKey: keys.versions(id) });
      qc.invalidateQueries({ queryKey: keys.canvases });
    },
  });
}

/** Regenerate slug — await; the old URL dies. */
export function useRegenerateSlug(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.regenerateSlug(id),
    onSuccess: (canvas) => {
      qc.setQueryData(keys.canvas(id), canvas);
      qc.invalidateQueries({ queryKey: keys.canvases });
    },
  });
}

/** Regenerate key — await; returns the new key once. */
export function useRegenerateKey(id: string) {
  return useMutation({ mutationFn: () => api.regenerateKey(id) });
}

/** Delete — await; removes from the list. */
export function useDeleteCanvas(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteCanvas(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.canvases });
    },
  });
}
