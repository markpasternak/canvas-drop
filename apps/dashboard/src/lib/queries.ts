import { useQuery } from "@tanstack/react-query";
import { type AdminCanvasStatus, api } from "./api.js";

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

export function useUsage(id: string) {
  return useQuery({ queryKey: keys.usage(id), queryFn: () => api.getUsage(id) });
}

// --- Admin (§6.10, M7) ---

export function useAdminCanvases(status?: AdminCanvasStatus) {
  return useQuery({
    queryKey: keys.adminCanvases(status),
    queryFn: () => api.admin.listCanvases(status),
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
