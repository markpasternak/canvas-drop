import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type AdminCanvasesQuery,
  type AdminUsersQuery,
  api,
  type CanvasesQuery,
  type GalleryQuery,
} from "./api.js";

export const keys = {
  me: ["me"] as const,
  // Base key for the owner's canvases — mutations invalidate this prefix, which
  // (by React Query's prefix match) also invalidates every parameterized list key.
  canvases: ["canvases"] as const,
  // Per-filter/page list key (plan 005). Prefixed under `canvases` so the existing
  // invalidations still hit it.
  canvasesList: (query: CanvasesQuery) => ["canvases", "list", query] as const,
  canvas: (id: string) => ["canvas", id] as const,
  versions: (id: string) => ["versions", id] as const,
  draft: (id: string) => ["draft", id] as const,
  usage: (id: string) => ["usage", id] as const,
  adminCanvases: (query: AdminCanvasesQuery) => ["admin", "canvases", query] as const,
  adminUsers: (query: AdminUsersQuery) => ["admin", "users", query] as const,
  adminOverview: ["admin", "overview"] as const,
  adminAiUsage: ["admin", "ai-usage"] as const,
  adminConfig: ["admin", "config"] as const,
  gallery: (query: GalleryQuery) => ["gallery", query] as const,
  galleryFacets: ["gallery", "facets"] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: api.me });
}

export function useCanvases(query: CanvasesQuery = {}) {
  return useQuery({
    queryKey: keys.canvasesList(query),
    queryFn: () => api.listCanvases(query),
    // Keep the previous page/filter result on screen while the next loads, so
    // paging and typing don't flash an empty list (mirrors useGallery).
    placeholderData: keepPreviousData,
  });
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
 * The admin all-canvases list with server-side filter/search/sort + offset paging
 * (plan 006). `keepPreviousData` keeps the table on screen while a new page/filter
 * loads, mirroring the member Your-canvases list.
 */
export function useAdminCanvases(query: AdminCanvasesQuery = {}) {
  return useQuery({
    queryKey: keys.adminCanvases(query),
    queryFn: () => api.admin.listCanvases(query),
    placeholderData: keepPreviousData,
  });
}

/** The admin user-management list, server-side filter/search/sort + offset paging. */
export function useAdminUsers(query: AdminUsersQuery = {}) {
  return useQuery({
    queryKey: keys.adminUsers(query),
    queryFn: () => api.admin.listUsers(query),
    placeholderData: keepPreviousData,
  });
}

export function useAdminOverview() {
  return useQuery({ queryKey: keys.adminOverview, queryFn: api.admin.overview });
}

export function useAdminAiUsage() {
  return useQuery({ queryKey: keys.adminAiUsage, queryFn: api.admin.aiUsage });
}

export function useAdminConfig() {
  return useQuery({ queryKey: keys.adminConfig, queryFn: api.admin.getConfig });
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

/** The pickable owner/tag lists for the gallery filter UI (plan 004). Loaded once;
 *  the lists change rarely relative to a browse session. */
export function useGalleryFacets() {
  return useQuery({ queryKey: keys.galleryFacets, queryFn: api.listGalleryFacets });
}
