import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Canvas } from "../lib/api.js";
import { api } from "../lib/api.js";
import { useUpdateSettings } from "../lib/mutations.js";
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
});
