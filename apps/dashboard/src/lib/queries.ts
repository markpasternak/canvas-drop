import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";

export const keys = {
  me: ["me"] as const,
  canvases: ["canvases"] as const,
  archivedCanvases: ["canvases", "archived"] as const,
  canvas: (id: string) => ["canvas", id] as const,
  versions: (id: string) => ["versions", id] as const,
  draft: (id: string) => ["draft", id] as const,
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
