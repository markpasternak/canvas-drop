import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Me } from "../lib/api.js";
import { keys } from "../lib/queries.js";
import { SkinSync } from "../lib/skin.js";

const baseMe: Me = {
  id: "u1",
  email: "u@example.com",
  name: "U",
  avatarUrl: null,
  isAdmin: false,
  canPublishPublic: false,
  authMode: "dev",
  urlMode: "path",
  baseUrl: "http://localhost",
};

function renderWithMe(me: Me) {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  qc.setQueryData(keys.me, me);
  return render(
    <QueryClientProvider client={qc}>
      <SkinSync />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  document.documentElement.removeAttribute("data-skin");
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("SkinSync", () => {
  it("applies a non-default skin from /api/me to <html data-skin> and caches it", async () => {
    renderWithMe({ ...baseMe, designSkin: "workshop" });
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-skin")).toBe("workshop"),
    );
    expect(localStorage.getItem("canvas-drop-skin")).toBe("workshop");
  });

  it("clears any data-skin for the editorial default (base :root)", async () => {
    document.documentElement.setAttribute("data-skin", "canvas"); // stale from a prior skin
    renderWithMe({ ...baseMe, designSkin: "editorial" });
    await waitFor(() => expect(document.documentElement.getAttribute("data-skin")).toBeNull());
    expect(localStorage.getItem("canvas-drop-skin")).toBeNull();
  });

  it("is a no-op when /api/me carries no skin", () => {
    renderWithMe(baseMe);
    expect(document.documentElement.getAttribute("data-skin")).toBeNull();
  });
});
