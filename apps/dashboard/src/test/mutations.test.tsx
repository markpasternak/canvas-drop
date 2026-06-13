import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Canvas } from "../lib/api.js";
import { api } from "../lib/api.js";
import { useArchiveCanvas, useUnarchiveCanvas, useUpdateSettings } from "../lib/mutations.js";
import { keys } from "../lib/queries.js";

const CANVAS: Canvas = {
  id: "c1",
  slug: "quiet-otter",
  url: "http://x/c/quiet-otter",
  title: "Demo",
  description: null,
  shared: false,
  sharedExpiresAt: null,
  hasPassword: false,
  spaFallback: false,
  galleryListed: false,
  gallerySummary: null,
  galleryTags: null,
  status: "active",
  currentVersionId: null,
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

describe("useArchiveCanvas / useUnarchiveCanvas", () => {
  it("archive calls POST /archive and invalidates both the active and archive lists", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    vi.spyOn(api, "archiveCanvas").mockResolvedValue({ ...CANVAS, status: "archived" });

    const { result } = renderHook(() => useArchiveCanvas("c1"), { wrapper: wrapper(qc) });
    result.current.mutate();

    await waitFor(() => expect(api.archiveCanvas).toHaveBeenCalledWith("c1"));
    // the canvas detail reflects the new status, and BOTH lists are invalidated so
    // the canvas visibly moves between the active list and the archive view.
    await waitFor(() =>
      expect(qc.getQueryData<Canvas>(keys.canvas("c1"))?.status).toBe("archived"),
    );
    const invalidatedKeys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(invalidatedKeys).toContain(JSON.stringify(keys.canvases));
    expect(invalidatedKeys).toContain(JSON.stringify(keys.archivedCanvases));
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
