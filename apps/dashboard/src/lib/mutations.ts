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
        if (patch.tags !== undefined) optimistic.tags = patch.tags;
        if (patch.shared !== undefined) optimistic.shared = patch.shared;
        if (patch.sharedExpiresAt !== undefined) optimistic.sharedExpiresAt = patch.sharedExpiresAt;
        if (patch.spaFallback !== undefined) optimistic.spaFallback = patch.spaFallback;
        if (patch.previewMode !== undefined) optimistic.previewMode = patch.previewMode;
        if (patch.galleryListed !== undefined) optimistic.galleryListed = patch.galleryListed;
        if (patch.galleryTemplatable !== undefined)
          optimistic.galleryTemplatable = patch.galleryTemplatable;
        if (patch.guestAiEnabled !== undefined) optimistic.guestAiEnabled = patch.guestAiEnabled;
        if (patch.guestAiCap !== undefined) optimistic.guestAiCap = patch.guestAiCap;
        if (patch.access !== undefined) {
          optimistic.access = patch.access;
          // `shared` is the derived "anyone but the owner can open it" boolean
          // (access !== "private"); keep it in lockstep so the rung and the legacy
          // chip don't flicker apart while the write is in flight.
          optimistic.shared = patch.access !== "private";
        }
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
 * Custom preview image (plan 004). Uploading pins an owner-chosen cover
 * (previewMode="custom") that publishes never overwrite; clearing reverts to
 * "auto". Both return the updated canvas, so we seed the cache and invalidate the
 * preview-backed surfaces (the cover URL is cache-busted by `updatedAt`).
 */
export function useUploadPreview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ image, contentType }: { image: ArrayBuffer; contentType: string }) =>
      api.uploadPreview(id, image, contentType),
    onSuccess: (canvas) => {
      qc.setQueryData(keys.canvas(id), canvas);
      qc.invalidateQueries({ queryKey: keys.canvas(id) });
      qc.invalidateQueries({ queryKey: keys.canvases });
    },
  });
}

export function useClearPreview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearPreview(id),
    onSuccess: (canvas) => {
      qc.setQueryData(keys.canvas(id), canvas);
      qc.invalidateQueries({ queryKey: keys.canvas(id) });
      qc.invalidateQueries({ queryKey: keys.canvases });
    },
  });
}

/**
 * Clone a canvas into a new one owned by the caller (plan 002). The source id is
 * the mutation variable (an own-canvas id or a gallery item's id), so one hook
 * serves every clone affordance. On success the caller navigates to the new
 * canvas's editor; we invalidate the canvases list so it shows up there too.
 */
export function useCloneCanvas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.cloneCanvas(sourceId),
    onSuccess: () => {
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
        // Optimistic `effective`: kv/files have no operator global, so backend &&
        // flag is authoritative. ai/realtime are ALSO gated by an operator global
        // the browser can't see, so we NEVER optimistically turn them ON — we cap
        // at the prior effective state and let onSettled confirm any upward
        // transition. This keeps the "disabled by administrator" hint from briefly
        // clearing when a globally-disabled feature is toggled on (the server
        // remains authoritative either way).
        const localOn = (feature: keyof typeof capabilities) =>
          backendEnabled && capabilities[feature];
        const optimistic: Canvas = {
          ...prev,
          backendEnabled,
          capabilities,
          effective: {
            identity: backendEnabled,
            kv: localOn("kv"),
            files: localOn("files"),
            ai: localOn("ai") && prev.effective.ai,
            realtime: localOn("realtime") && prev.effective.realtime,
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

/**
 * Create a new empty draft file ("Add a file"). Distinct from useSaveDraftFile: it
 * uses the create-only endpoint, so adding a path that already exists fails with
 * PATH_EXISTS rather than truncating the existing file.
 */
export function useCreateDraftFile(id: string) {
  const qc = useQueryClient();
  return useMutation({
    scope: { id: `draft-${id}` },
    mutationFn: (path: string) => api.createDraftFile(id, path),
    onSuccess: (draft: DraftView) => qc.setQueryData(keys.draft(id), draft),
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
    onSuccess: (draft: DraftView) => {
      qc.setQueryData(keys.draft(id), draft);
      // A restore changes which version the draft mirrors — refresh the Versions
      // tab (count / current pointer / dirty-state guard), mirroring useUnpublishCanvas.
      qc.invalidateQueries({ queryKey: keys.versions(id) });
    },
  });
}

/** Regenerate slug — await; the old URL dies. Pass a slug for a custom one, omit for random. */
export function useRegenerateSlug(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug?: string) => api.regenerateSlug(id, slug),
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

/** Invalidate every surface a lifecycle change moves a canvas between: the canvas
 *  detail and the canvas list (the `keys.canvases` prefix covers every parameterized
 *  list key, including the `?scope=archived` view). */
function invalidateLifecycle(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: keys.canvas(id) });
  qc.invalidateQueries({ queryKey: keys.canvases });
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

/** Unpublish — await; takes a Published canvas back to Draft (offline + de-listed).
 *  Invalidates versions too: the current pointer is cleared. */
export function useUnpublishCanvas(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.unpublishCanvas(id),
    onSuccess: (canvas) => {
      qc.setQueryData(keys.canvas(id), canvas);
      qc.invalidateQueries({ queryKey: keys.versions(id) });
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

/** Outcome of a bulk lifecycle op: the ids that settled each way, so the caller
 *  can report "Archived 4 · 1 failed" and keep any failures selected. */
export interface BulkResult {
  succeeded: string[];
  failed: string[];
}

/** Run one per-canvas lifecycle call across many ids. The page only ever shows a
 *  single page of canvases, so the fan-out is small and bounded; allSettled lets a
 *  single failure (e.g. a canvas changed state in another tab) not sink the batch.
 *  Reuses the same endpoints as the single-row actions — no batch API or new MCP
 *  tool, so agent-native parity holds (an agent loops the existing per-id tool). */
function useBulkLifecycle(op: (id: string) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]): Promise<BulkResult> => {
      const settled = await Promise.allSettled(ids.map((id) => op(id)));
      const succeeded: string[] = [];
      const failed: string[] = [];
      settled.forEach((result, index) => {
        const id = ids[index];
        if (id === undefined) return;
        (result.status === "fulfilled" ? succeeded : failed).push(id);
      });
      return { succeeded, failed };
    },
    // A bulk op can move every selected canvas between lifecycle views — invalidate
    // the whole list prefix (covers the active + archived parameterized keys).
    onSettled: () => qc.invalidateQueries({ queryKey: keys.canvases }),
  });
}

/** Bulk archive selected canvases (Your-canvases active view). */
export function useBulkArchive() {
  return useBulkLifecycle((id) => api.archiveCanvas(id));
}

/** Bulk unarchive selected canvases (Your-canvases archived view). */
export function useBulkUnarchive() {
  return useBulkLifecycle((id) => api.unarchiveCanvas(id));
}

/** Bulk delete selected canvases (recoverable for 30 days, then purged). */
export function useBulkDelete() {
  return useBulkLifecycle((id) => api.deleteCanvas(id));
}

// --- Admin (§6.10, M7). Confirm-and-await (not optimistic) — takedown/restore
//     are consequential. Each invalidates the admin list + overview. ---

function invalidateAdmin(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["admin"] });
}

export function useAdminDisableCanvas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.admin.disableCanvas(id, reason),
    onSuccess: () => invalidateAdmin(qc),
  });
}

export function useAdminEnableCanvas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.admin.enableCanvas(id),
    onSuccess: () => invalidateAdmin(qc),
  });
}

export function useAdminRestoreCanvas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.admin.restoreCanvas(id),
    onSuccess: () => invalidateAdmin(qc),
  });
}

/** Set/unset the admin-curated `galleryFeatured` flag (KTD3). Admin-only on the
 *  server; await-then-invalidate so the table + overview reflect the new state. */
export function useSetFeatured() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, featured }: { id: string; featured: boolean }) =>
      api.admin.setFeatured(id, featured),
    onSuccess: () => invalidateAdmin(qc),
  });
}

// --- Admin user management (plan 006). Block/unblock + promote/demote; each
//     invalidates the admin tree (the user list + overview counts). The server
//     enforces self-protection + last-admin guards — the UI just surfaces them. ---

export function useAdminBlockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, blocked }: { id: string; blocked: boolean }) =>
      blocked ? api.admin.blockUser(id) : api.admin.unblockUser(id),
    onSuccess: () => invalidateAdmin(qc),
  });
}

export function useAdminPromoteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, admin }: { id: string; admin: boolean }) =>
      admin ? api.admin.promoteUser(id) : api.admin.demoteUser(id),
    onSuccess: () => invalidateAdmin(qc),
  });
}

/** Grant/revoke the publish-public capability (U10). Revoking sweeps the owner's
 *  public_link canvases back to private, so invalidate the canvas lists too — not
 *  just the admin views — or an owner's open list/detail shows a stale rung. */
export function useAdminPublishPublic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, allowed }: { id: string; allowed: boolean }) =>
      allowed ? api.admin.grantPublic(id) : api.admin.revokePublic(id),
    onSuccess: () => {
      invalidateAdmin(qc);
      // The revoke sweep flips canvases to private — invalidate BOTH the list
      // (['canvases']) and every canvas detail (['canvas', id]) so an owner with a
      // detail tab open doesn't keep rendering a stale "Public" rung.
      qc.invalidateQueries({ queryKey: keys.canvases });
      qc.invalidateQueries({ queryKey: ["canvas"] });
    },
  });
}

/** Add an individual sign-in allowlist email (D14 supplement to env domains). */
export function useAddAllowedEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => api.admin.addAllowedEmail(email),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.adminAllowedEmails }),
  });
}

/** Remove an individual sign-in allowlist email. */
export function useRemoveAllowedEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.admin.removeAllowedEmail(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.adminAllowedEmails }),
  });
}

/** Set or clear (value === null) a DB override for an editable config setting. */
export function useAdminSetConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      value,
    }: {
      key: string;
      value: string | number | boolean | string[] | null;
    }) => (value === null ? api.admin.clearConfig(key) : api.admin.setConfig(key, value)),
    // The effective AI key/models also feed the capabilities view; refresh broadly.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
  });
}
