import { useMutation, useQueryClient } from "@tanstack/react-query";
import { folderFormFromFiles } from "../components/DeployFiles.js";
import {
  api,
  type Canvas,
  type CanvasCapabilitiesPatch,
  type CanvasSettings,
  type DraftView,
} from "./api.js";
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

/**
 * Capability update (plan 006) — OPTIMISTIC, mirroring useUpdateSettings. Applies
 * the master/feature flags to the cached `capabilities`/`backendEnabled` and
 * recomputes `effective` so disabled-feature hints update without a round-trip.
 * The server is authoritative; onSettled re-syncs (e.g. operator-global gating).
 */
export function useUpdateCapabilities(id: string) {
  const qc = useQueryClient();
  return useMutation({
    scope: { id: `capabilities-${id}` },
    mutationFn: (patch: CanvasCapabilitiesPatch) => api.updateCapabilities(id, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: keys.canvas(id) });
      const prev = qc.getQueryData<Canvas>(keys.canvas(id));
      if (prev) {
        const backendEnabled = patch.backendEnabled ?? prev.backendEnabled;
        const capabilities = {
          kv: patch.kv ?? prev.capabilities.kv,
          files: patch.files ?? prev.capabilities.files,
          ai: patch.ai ?? prev.capabilities.ai,
          realtime: patch.realtime ?? prev.capabilities.realtime,
        };
        // Optimistic `effective` reflects only backend && flag — the operator
        // global gating (ai/realtime) lives server-side and is re-synced by
        // onSettled. A feature already gated off by the operator stays shown that
        // way: keep the prior effective when the patch didn't change its inputs.
        const eff = (feature: keyof typeof capabilities): boolean => {
          const localOn = backendEnabled && capabilities[feature];
          const inputsUnchanged =
            backendEnabled === prev.backendEnabled &&
            capabilities[feature] === prev.capabilities[feature];
          return inputsUnchanged ? prev.effective[feature] : localOn;
        };
        const optimistic: Canvas = {
          ...prev,
          backendEnabled,
          capabilities,
          effective: {
            identity: backendEnabled,
            kv: eff("kv"),
            files: eff("files"),
            ai: eff("ai"),
            realtime: eff("realtime"),
          },
        };
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

/** A new deploy to an existing canvas, by method. ZIP/folder report upload
 *  progress (0–1); paste is a small JSON request. */
export type DeployInput =
  | { kind: "paste"; html: string }
  | { kind: "folder"; files: File[] }
  | { kind: "zip"; file: File };

/** Deploy a new version to an existing canvas — await + invalidate (changes the
 *  live canvas and adds to its version history). */
export function useDeploy(id: string, onProgress?: (fraction: number) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeployInput) => {
      switch (input.kind) {
        case "paste":
          return api.deployPaste(id, input.html);
        case "folder":
          return api.deployFolder(id, folderFormFromFiles(input.files), onProgress);
        case "zip":
          return api.deployZip(id, await input.file.arrayBuffer(), onProgress);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.canvas(id) });
      qc.invalidateQueries({ queryKey: keys.versions(id) });
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

// --- In-browser editor / draft (M5) ---

/** Save a draft file (autosaved by the editor). Updates the draft cache in place. */
export function useSaveDraftFile(id: string) {
  const qc = useQueryClient();
  return useMutation({
    // Serialize draft writes for this canvas so overlapping autosaves settle in order.
    scope: { id: `draft-${id}` },
    mutationFn: (input: { path: string; content: string }) =>
      api.putDraftFile(id, input.path, input.content),
    onSuccess: (draft) => qc.setQueryData(keys.draft(id), draft),
  });
}

/** Replace/upload a single draft file with raw bytes (binary-safe). */
export function useUploadDraftFile(id: string) {
  const qc = useQueryClient();
  return useMutation({
    scope: { id: `draft-${id}` },
    mutationFn: (input: { path: string; file: Blob }) =>
      api.uploadDraftFile(id, input.path, input.file),
    onSuccess: (draft: DraftView) => qc.setQueryData(keys.draft(id), draft),
  });
}

/**
 * Upload many files into the draft (drag-drop / picker add). Sequential by design:
 * each draft write is a full-manifest overwrite server-side, so parallel uploads
 * would race and lose entries. Returns the count uploaded; invalidates the draft.
 */
export function useUploadDraftFiles(id: string) {
  const qc = useQueryClient();
  return useMutation({
    scope: { id: `draft-${id}` },
    mutationFn: async (files: Array<{ path: string; file: Blob }>) => {
      for (const f of files) await api.uploadDraftFile(id, f.path, f.file);
      return files.length;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.draft(id) }),
  });
}

/** Delete a draft file. */
export function useDeleteDraftFile(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.deleteDraftFile(id, path),
    onSuccess: (draft: DraftView) => qc.setQueryData(keys.draft(id), draft),
  });
}

/** Rename/move a draft file. */
export function useRenameDraftFile(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      api.renameDraftFile(id, input.from, input.to),
    onSuccess: (draft: DraftView) => qc.setQueryData(keys.draft(id), draft),
  });
}

/** Publish the draft as a new live version — invalidates the canvas, versions, and draft. */
export function usePublishDraft(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.publishDraft(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.canvas(id) });
      qc.invalidateQueries({ queryKey: keys.versions(id) });
      qc.invalidateQueries({ queryKey: keys.canvases });
      qc.invalidateQueries({ queryKey: keys.draft(id) });
    },
  });
}

/** Restore a published version into the draft — replaces the draft cache. */
export function useRestoreToDraft(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => api.restoreToDraft(id, version),
    onSuccess: (draft: DraftView) => qc.setQueryData(keys.draft(id), draft),
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

/** Invalidate every surface a lifecycle change moves a canvas between: the
 *  canvas detail, the active list, and the archive list. (`keys.canvases` is a
 *  prefix of `keys.archivedCanvases`, but we invalidate both explicitly so the
 *  intent survives any future key reshaping.) */
function invalidateLifecycle(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: keys.canvas(id) });
  qc.invalidateQueries({ queryKey: keys.canvases });
  qc.invalidateQueries({ queryKey: keys.archivedCanvases });
}

/** Archive — await; takes the canvas offline and moves it to the Archive view. */
export function useArchiveCanvas(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.archiveCanvas(id),
    onSuccess: (canvas) => {
      qc.setQueryData(keys.canvas(id), canvas);
      invalidateLifecycle(qc, id);
    },
  });
}

/** Unarchive — await; restores the canvas to active and back into the main list. */
export function useUnarchiveCanvas(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.unarchiveCanvas(id),
    onSuccess: (canvas) => {
      qc.setQueryData(keys.canvas(id), canvas);
      invalidateLifecycle(qc, id);
    },
  });
}
