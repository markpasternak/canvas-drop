import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Canvas } from "../lib/api.js";
import { api } from "../lib/api.js";
import {
  useArchiveCanvas,
  useUnarchiveCanvas,
  useUpdateCapabilities,
  useUpdateSettings,
} from "../lib/mutations.js";
import { keys } from "../lib/queries.js";

const CANVAS: Canvas = {
  id: "c1",
  slug: "quiet-otter",
  slugCustom: false,
  url: "http://x/c/quiet-otter",
  hasPreview: false,
  title: "Demo",
  description: null,
  access: "private",
  shared: false,
  guestAiEnabled: false,
  guestAiCap: 0,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  previewMode: "auto",
  galleryListed: false,
  galleryTemplatable: false,
  tags: null,
  clonedFromCanvasId: null,
  backendEnabled: false,
  capabilities: { kv: true, files: true, ai: true, realtime: true },
  effective: { identity: false, kv: false, files: false, ai: false, realtime: false },
  status: "active",
  publicationState: "draft",
  disabledReason: null,
  currentVersionId: null,
  viewCount: 0,
  lastViewedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

afterEach(() => vi.restoreAllMocks());

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("useUpdateSettings (optimistic)", () => {
  it("applies the toggle immediately then rolls back on error", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData(keys.canvas("c1"), CANVAS);

    // A deferred rejection so the optimistic intermediate state is observable.
    let reject: (e: Error) => void = () => {};
    vi.spyOn(api, "updateSettings").mockReturnValue(
      new Promise((_res, rej) => {
        reject = rej;
      }),
    );

    const { result } = renderHook(() => useUpdateSettings("c1"), { wrapper: wrapper(qc) });
    result.current.mutate({ shared: true });

    // optimistic: cache flips to shared immediately (before the request settles)
    await waitFor(() => expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.shared).toBe(true));
    // now fail the request → rollback to the snapshot
    reject(new Error("boom"));
    await waitFor(() => expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.shared).toBe(false));
  });

  it("rapid overlapping toggles converge to the last intent (scope-serialized)", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData(keys.canvas("c1"), CANVAS);
    // Echo the patch back as the server would; mutations for this canvas are
    // scope-serialized, so they can't snapshot each other's optimistic state.
    vi.spyOn(api, "updateSettings").mockImplementation(async (_id, patch) => ({
      ...CANVAS,
      ...patch,
    }));

    const { result } = renderHook(() => useUpdateSettings("c1"), { wrapper: wrapper(qc) });
    result.current.mutate({ shared: true });
    result.current.mutate({ shared: false });

    // The cache converges to the LAST intent (false), not a stale rollback.
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.shared).toBe(false));
  });
});

describe("useUpdateCapabilities (optimistic)", () => {
  const ON: Canvas = {
    ...CANVAS,
    backendEnabled: true,
    capabilities: { kv: true, files: true, ai: true, realtime: true },
    effective: { identity: true, kv: true, files: true, ai: true, realtime: true },
  };

  it("flips a feature flag + effective immediately, then rolls back on error", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData(keys.canvas("c1"), ON);
    let reject: (e: Error) => void = () => {};
    vi.spyOn(api, "updateCapabilities").mockReturnValue(
      new Promise((_res, rej) => {
        reject = rej;
      }),
    );

    const { result } = renderHook(() => useUpdateCapabilities("c1"), { wrapper: wrapper(qc) });
    result.current.mutate({ kv: false });

    await waitFor(() => {
      const cv = qc.getQueryData<Canvas>(keys.canvas("c1"));
      expect(cv?.capabilities.kv).toBe(false);
      expect(cv?.effective.kv).toBe(false);
    });
    reject(new Error("boom"));
    await waitFor(() =>
      expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.capabilities.kv).toBe(true),
    );
  });

  it("never optimistically turns an operator-gated feature ON (adversarial regression)", async () => {
    // Backend on, AI flag stored ON but operator has globally disabled AI, so
    // effective.ai is false (the "disabled by administrator" state).
    const gated: Canvas = { ...ON, effective: { ...ON.effective, ai: false } };
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData(keys.canvas("c1"), gated);
    vi.spyOn(api, "updateCapabilities").mockReturnValue(new Promise(() => {})); // never settles

    const { result } = renderHook(() => useUpdateCapabilities("c1"), { wrapper: wrapper(qc) });
    // Toggle an UNRELATED feature; the operator-gated AI hint must not clear.
    result.current.mutate({ kv: false });

    await waitFor(() =>
      expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.effective.kv).toBe(false),
    );
    expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.effective.ai).toBe(false);
  });

  it("toggling an operator-gated feature ON does not optimistically show it effective", async () => {
    // AI flag stored OFF and operator-disabled (effective.ai false).
    const gated: Canvas = {
      ...ON,
      capabilities: { ...ON.capabilities, ai: false },
      effective: { ...ON.effective, ai: false },
    };
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData(keys.canvas("c1"), gated);
    vi.spyOn(api, "updateCapabilities").mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useUpdateCapabilities("c1"), { wrapper: wrapper(qc) });
    result.current.mutate({ ai: true });

    await waitFor(() =>
      expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.capabilities.ai).toBe(true),
    );
    // stored flag flips, but effective stays false until the server confirms the global
    expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.effective.ai).toBe(false);
  });
});

describe("useArchiveCanvas / useUnarchiveCanvas", () => {
  it("archive calls POST /archive and invalidates both the active and archive lists", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    vi.spyOn(api, "archiveCanvas").mockResolvedValue({ ...CANVAS, status: "archived" });

    const { result } = renderHook(() => useArchiveCanvas("c1"), { wrapper: wrapper(qc) });
    result.current.mutate();

    await waitFor(() => expect(api.archiveCanvas).toHaveBeenCalledWith("c1"));
    // the canvas detail reflects the new status, and the canvas list is invalidated
    // (the `keys.canvases` prefix covers the active and `?scope=archived` views) so
    // the canvas visibly moves between them.
    await waitFor(() =>
      expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.status).toBe("archived"),
    );
    const invalidatedKeys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(invalidatedKeys).toContain(JSON.stringify(keys.canvases));
  });

  it("unarchive calls POST /unarchive and restores the active status", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    vi.spyOn(api, "unarchiveCanvas").mockResolvedValue({ ...CANVAS, status: "active" });

    const { result } = renderHook(() => useUnarchiveCanvas("c1"), { wrapper: wrapper(qc) });
    result.current.mutate();

    await waitFor(() => expect(api.unarchiveCanvas).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.status).toBe("active"));
  });
});
