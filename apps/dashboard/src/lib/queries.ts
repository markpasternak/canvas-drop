import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type AdminCanvasStatus, api, type GalleryQuery } from "./api.js";

export const keys = {
  me: ["me"] as const,
  canvases: ["canvases"] as const,
  archivedCanvases: ["canvases", "archived"] as const,
  canvas: (id: string) => ["canvas", id] as const,
  versions: (id: string) => ["versions", id] as const,
  draft: (id: string) => ["draft", id] as const,
  usage: (id: string) => ["usage", id] as const,
  adminCanvases: (status?: AdminCanvasStatus) => ["admin", "canvases", status ?? "all"] as const,
  adminOverview: ["admin", "overview"] as const,
  adminModels: ["admin", "models"] as const,
  adminQuotas: ["admin", "quotas"] as const,
  gallery: (query: GalleryQuery) => ["gallery", query] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: api.me });
}

export function useCanvases() {
  return useQuery({ queryKey: keys.canvases, queryFn: api.listCanvases });
}

export function useArchivedCanvases() {
  return useQuery({ queryKey: keys.archivedCanvases, queryFn: api.listArchivedCanvases });
}

export function useCanvas(id: string) {
  return useQuery({ queryKey: keys.canvas(id), queryFn: () => api.getCanvas(id) });
}

export function useVersions(id: string) {
  return useQuery({ queryKey: keys.versions(id), queryFn: () => api.listVersions(id) });
}

export function useDraft(id: string) {
  return useQuery({ queryKey: keys.draft(id), queryFn: () => api.getDraft(id) });
}

// `enabled` lets callers skip the request for canvases with no backend — there's
// no primitive usage to show, so the Usage tab renders an empty state instead.
export function useUsage(id: string, enabled = true) {
  return useQuery({ queryKey: keys.usage(id), queryFn: () => api.getUsage(id), enabled });
}

// --- Admin (§6.10, M7) ---

/**
 * The admin all-canvases list, keyset-paginated. Returns every loaded page;
 * callers flatten `data.pages` and drive "Load more" off `hasNextPage`. The
 * server caps each page at 50, so a plain query would silently hide the rest.
 */
export function useAdminCanvases(status?: AdminCanvasStatus) {
  return useInfiniteQuery({
    queryKey: keys.adminCanvases(status),
    queryFn: ({ pageParam }) => api.admin.listCanvases(status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useAdminOverview() {
  return useQuery({ queryKey: keys.adminOverview, queryFn: api.admin.overview });
}

export function useAdminModels() {
  return useQuery({ queryKey: keys.adminModels, queryFn: api.admin.getModels });
}

export function useAdminQuotas() {
  return useQuery({ queryKey: keys.adminQuotas, queryFn: api.admin.getQuotas });
}

export function useGallery(query: GalleryQuery) {
  return useQuery({
    queryKey: keys.gallery(query),
    queryFn: () => api.listGallery(query),
    // Keep the previous page on screen while the next page / search loads so
    // paging and typing don't flash an empty grid.
    placeholderData: keepPreviousData,
  });
}
