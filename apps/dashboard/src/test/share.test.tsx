import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast.js";
import { ThemeProvider } from "../lib/theme.js";
import { routeTree } from "../router.js";

const CANVAS = {
  id: "c1",
  slug: "quiet-otter",
  url: "http://x/c/quiet-otter",
  title: "My Canvas",
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
  status: "active",
  publicationState: "draft",
  disabledReason: null,
  currentVersionId: null,
  createdAt: 0,
  updatedAt: 0,
};

const ME = {
  id: "u1",
  email: "owner@example.com",
  name: "Owner",
  avatarUrl: null,
  isAdmin: false,
  canPublishPublic: false,
  authMode: "dev",
  // An org member (the Team rung is gated on org membership).
  orgs: [{ id: "o1", name: "Acme" }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const defaults: Record<string, () => Response> = {
    "GET /api/me": () => json(ME),
    // The share control loads the caller's teams for the Team rung picker (plan 003);
    // default to none so existing tests don't hit the unmocked fallback.
    "GET /api/teams": () => json({ teams: [] }),
    "GET /api/people/search": () => json({ people: [] }),
  };
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    calls.push({ method, url: path, body: init?.body as string | undefined });
    const handler = handlers[`${method} ${path}`] ?? defaults[`${method} ${path}`];
    if (handler) return handler();
    return json({ error: "not_mocked" }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function renderShare() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/canvases/c1/share"] }),
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          {/* biome-ignore lint/suspicious/noExplicitAny: test router instance */}
          <RouterProvider router={router as any} />
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("share route", () => {
  it("sets a password via PATCH", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () => json({ ...published, hasPassword: true }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.type(await screen.findByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /set password/i }));

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toContain("hunter2");
    });
  });

  it("surfaces the server's CDN staleness warning as a toast (password path)", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () =>
        json({
          ...published,
          hasPassword: true,
          warning: "CDN edge may keep showing this canvas.",
        }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.type(await screen.findByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /set password/i }));

    expect(await screen.findByText(/CDN edge may keep showing this canvas/i)).toBeInTheDocument();
  });

  it("surfaces the CDN warning when an access change (save) returns one", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () =>
        json({
          ...published,
          access: "whole_org",
          warning: "Heads up: a CDN may keep serving it.",
        }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("radio", { name: /whole org/i }));
    expect(await screen.findByText(/a CDN may keep serving it/i)).toBeInTheDocument();
  });

  it("shows an error toast when an access change (save) fails (no silent swallow)", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "PATCH /api/canvases/c1/settings": () =>
        json(
          { code: "SHARE_REQUIRES_PUBLISH", message: "Could not change the access level." },
          409,
        ),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("radio", { name: /whole org/i }));
    expect(await screen.findByText(/could not change the access level/i)).toBeInTheDocument();
  });

  it("Generate fills a strong password and reveals it for copying", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
    });
    const user = userEvent.setup();
    renderShare();

    const input = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.type).toBe("password");

    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(input.value.length).toBeGreaterThanOrEqual(16);
    expect(input.type).toBe("text");
  });

  it("unpublished: shows ONE locked-panel explanation, not live access controls", async () => {
    mockFetch({ "GET /api/canvases/c1": () => json(CANVAS) });
    renderShare();

    // A single coherent explanation of the dependency — not a notice repeated under
    // every section.
    expect(await screen.findByText(/sharing unlocks after you publish/i)).toBeInTheDocument();
    expect(screen.getAllByText(/sharing unlocks after you publish/i)).toHaveLength(1);

    // The access ladder / gallery controls are NOT shown as live affordances.
    expect(screen.queryByRole("radio", { name: /whole org/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /list in the gallery/i })).toBeNull();

    // The CTA offers both ways forward (scoped to the locked panel, not the header).
    const panel = screen.getByRole("region", { name: /sharing unlocks after you publish/i });
    expect(within(panel).getByRole("button", { name: /^publish$/i })).toBeEnabled();
    expect(within(panel).getByRole("link", { name: /open draft/i })).toBeInTheDocument();
  });

  it("unpublished: Publish CTA fires the publish mutation and reveals the ladder in place", async () => {
    let published = false;
    mockFetch({
      "GET /api/canvases/c1": () =>
        published
          ? json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" })
          : json(CANVAS),
      "POST /api/canvases/c1/publish": () => {
        published = true;
        return json({ version: 1 });
      },
    });
    const user = userEvent.setup();
    renderShare();

    const panel = await screen.findByRole("region", {
      name: /sharing unlocks after you publish/i,
    });
    await user.click(within(panel).getByRole("button", { name: /^publish$/i }));

    // After publishing, the canvas-detail query is invalidated/refetched; the tab
    // re-renders with the access ladder revealed in place (no navigation).
    expect(await screen.findByRole("radio", { name: /whole org/i })).toBeEnabled();
    expect(screen.queryByText(/sharing unlocks after you publish/i)).toBeNull();
  });

  it("team rung: picking Team reveals the picker; sharing PATCHes access:team + teamIds", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    const calls = mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/teams": () =>
        json({
          teams: [
            { id: "t1", orgId: "o1", name: "Design", slug: "design", mine: true, canManage: true },
          ],
        }),
      "PATCH /api/canvases/c1/settings": () =>
        json({ ...published, access: "team", shared: true, teamIds: ["t1"] }),
    });
    const user = userEvent.setup();
    renderShare();

    // The rung exists between Specific people and Whole org.
    await user.click(await screen.findByRole("radio", { name: /^team/i }));
    // Picking it reveals the picker (no write yet — an empty team grant is a 409). The
    // checkbox label now also carries a scope badge ("Acme" / "Personal"), so match by substring.
    const teamCheckbox = await screen.findByLabelText(/Design/);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // The org-team scope badge shows the org name so the share target's reach is legible.
    expect(screen.getByText("Acme")).toBeInTheDocument();

    await user.click(teamCheckbox);
    await user.click(screen.getByRole("button", { name: /share with teams/i }));

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain('"access":"team"');
      expect(patch?.body).toContain("t1");
    });
  });

  it("team rung: shows a 'create a team' notice when the caller has no teams", async () => {
    const published = { ...CANVAS, publicationState: "published", currentVersionId: "v1" };
    mockFetch({
      "GET /api/canvases/c1": () => json(published),
      "GET /api/teams": () => json({ teams: [] }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("radio", { name: /^team/i }));
    expect(await screen.findByText(/not in any team yet/i)).toBeInTheDocument();
  });

  it("team rung is hidden for a guest (no org)", async () => {
    mockFetch({
      "GET /api/me": () => json({ ...ME, isGuest: true, orgs: [] }),
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
    });
    renderShare();
    await screen.findByRole("radio", { name: /private/i });
    expect(screen.queryByRole("radio", { name: /^team/i })).toBeNull();
  });

  it("whole-org rung is disabled on a Personal canvas, but the Team rung stays enabled (plan 003 U6)", async () => {
    mockFetch({
      "GET /api/me": () => json({ ...ME, orgs: [{ id: "o1", name: "Acme" }] }),
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, orgId: null, publicationState: "published", currentVersionId: "v1" }),
    });
    renderShare();
    // A personal canvas CAN be shared with a personal team — the Team rung is enabled…
    expect(await screen.findByRole("radio", { name: /^team/i })).toBeEnabled();
    // …but it still can't be shared org-wide.
    expect(screen.getByRole("radio", { name: /whole org/i })).toBeDisabled();
  });

  it("published: shows the live access ladder (rungs are enabled)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1" }),
    });
    renderShare();

    expect(await screen.findByRole("radio", { name: /private/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /whole org/i })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /specific people/i })).toBeEnabled();
  });

  it("shows the human-guessable heads-up for a custom slug on a link-reachable rung", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          slugCustom: true,
          publicationState: "published",
          access: "whole_org",
          shared: true,
          currentVersionId: "v1",
        }),
    });
    renderShare();
    expect(await screen.findByText(/custom, human-readable URL/i)).toBeInTheDocument();
  });

  it("hides the heads-up for a random slug on a link-reachable rung", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          slugCustom: false,
          publicationState: "published",
          access: "whole_org",
          shared: true,
          currentVersionId: "v1",
        }),
    });
    renderShare();
    await screen.findByRole("radio", { name: /whole org/i });
    expect(screen.queryByText(/custom, human-readable URL/i)).not.toBeInTheDocument();
  });

  it("hides the heads-up for a custom slug kept private (obscurity still applies)", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          slugCustom: true,
          publicationState: "published",
          access: "private",
          shared: false,
          currentVersionId: "v1",
        }),
    });
    renderShare();
    await screen.findByRole("radio", { name: /private/i });
    expect(screen.queryByText(/custom, human-readable URL/i)).not.toBeInTheDocument();
  });

  it("specific_people: shows the allowlist empty state and adds a member", async () => {
    const user = userEvent.setup();
    let added = false;
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "specific_people",
          shared: true,
          currentVersionId: "v1",
        }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: added
            ? [
                {
                  id: "e1",
                  kind: "member",
                  email: "colleague@example.com",
                  name: "C",
                  createdAt: 1,
                },
              ]
            : [],
        }),
      "POST /api/canvases/c1/allowlist": () => {
        added = true;
        return json({ ok: true, status: "granted" });
      },
    });
    renderShare();

    expect(await screen.findByText(/no one added yet/i)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/person's email/i), "colleague@example.com");
    await user.click(screen.getByRole("button", { name: "Add person" }));
    expect(await screen.findByText("colleague@example.com")).toBeInTheDocument();
  });

  it("specific_people: Add person records a pending external email", async () => {
    const user = userEvent.setup();
    let pending = false;
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "specific_people",
          shared: true,
          currentVersionId: "v1",
        }),
      "GET /api/canvases/c1/allowlist": () =>
        json({
          entries: pending
            ? [
                {
                  id: "pending:p1",
                  kind: "pending",
                  email: "newbie@example.com",
                  name: null,
                  createdAt: 1,
                },
              ]
            : [],
        }),
      "POST /api/canvases/c1/allowlist": () => {
        pending = true;
        return json({ ok: true, status: "pending" });
      },
    });
    renderShare();

    await user.type(await screen.findByLabelText(/person's email/i), "newbie@example.com");
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add person" }));
    expect(await screen.findByText("newbie@example.com")).toBeInTheDocument();
    expect(screen.getByText(/pending sign-in/i)).toBeInTheDocument();
    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/canvases/c1/allowlist");
      expect(post?.body).toContain("newbie@example.com");
    });
  });

  it("updates guest AI settings for specific people access", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "specific_people",
          shared: true,
          currentVersionId: "v1",
        }),
      "GET /api/canvases/c1/allowlist": () => json({ entries: [] }),
      "PATCH /api/canvases/c1/settings": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "specific_people",
          shared: true,
          currentVersionId: "v1",
          guestAiEnabled: true,
        }),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(await screen.findByRole("switch", { name: /let invited people use ai/i }));

    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain("guestAiEnabled");
      expect(patch?.body).toContain("true");
    });
  });

  it("warns when a shared canvas's expiry is already in the past", async () => {
    const past = Date.now() - 60 * 60 * 1000;
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", shared: true, sharedExpiresAt: past }),
    });
    renderShare();

    expect(await screen.findByText(/this share expired/i)).toBeInTheDocument();
    expect(screen.getByText(/non-owners now get a 404/i)).toBeInTheDocument();
  });

  it("shows no expiry warning when the expiry is still in the future", async () => {
    const future = Date.now() + 24 * 60 * 60 * 1000;
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", shared: true, sharedExpiresAt: future }),
    });
    renderShare();

    expect(await screen.findByText(/share expiry/i)).toBeInTheDocument();
    expect(screen.queryByText(/this share expired/i)).toBeNull();
  });

  it("gallery-listing control is discoverable but disabled until the canvas is gallery-eligible", async () => {
    // Published but still private: sharing is unlocked, so the gallery control is
    // visible, but listBlocker (only Whole-org / Public-link canvases can be listed)
    // keeps it disabled — specific_people/private never appear in the gallery.
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({ ...CANVAS, publicationState: "published", currentVersionId: "v1", shared: false }),
    });
    renderShare();

    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/only a whole-org or public-link canvas/i)).toBeInTheDocument();
  });

  it("gallery-listing control is enabled once the canvas is Whole-org AND published", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "whole_org",
          shared: true,
          currentVersionId: "v1",
        }),
    });
    renderShare();

    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeEnabled();
  });

  it("an unpublished canvas shows the locked panel, not the gallery-listing control", async () => {
    // The publish dependency is collapsed into the single locked panel (U13), so the
    // gallery section — and its listBlocker "publish first" notice — is not reachable
    // while the canvas is a draft. listBlocker still gates the published path below.
    mockFetch({
      "GET /api/canvases/c1": () => json({ ...CANVAS, shared: true, currentVersionId: null }),
    });
    renderShare();

    expect(await screen.findByText(/sharing unlocks after you publish/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /list in the gallery/i })).toBeNull();
  });

  it("gallery-listing is blocked for a password-protected canvas", async () => {
    // Whole-org + published, so the access/publish blockers clear and the password
    // blocker is the one that surfaces.
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          access: "whole_org",
          shared: true,
          currentVersionId: "v1",
          hasPassword: true,
        }),
    });
    renderShare();

    const toggle = await screen.findByRole("switch", { name: /list in the gallery/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/remove the password before listing/i)).toBeInTheDocument();
  });

  it("shows the template toggle once listed, and warns before a password unlists", async () => {
    const calls = mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          shared: true,
          currentVersionId: "v1",
          galleryListed: true,
        }),
      "PATCH /api/canvases/c1/settings": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          shared: true,
          currentVersionId: "v1",
          hasPassword: true,
        }),
    });
    const user = userEvent.setup();
    renderShare();

    expect(
      await screen.findByRole("switch", { name: /allow others to use as a template/i }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: /set password/i }));
    expect(await screen.findByText(/add a password and unlist/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    await user.click(screen.getByRole("button", { name: /add password & remove from gallery/i }));
    await vi.waitFor(() => {
      const patch = calls.find(
        (c) => c.method === "PATCH" && c.url === "/api/canvases/c1/settings",
      );
      expect(patch?.body).toContain("hunter2");
    });
  });

  it("gallery section has no editable tags input — it points to Overview instead", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          shared: true,
          currentVersionId: "v1",
          galleryListed: true,
        }),
    });
    renderShare();

    // The redundant gallery-tags input is gone (tags are a first-class Overview property).
    await screen.findByRole("switch", { name: /allow others to use as a template/i });
    expect(screen.queryByLabelText("Tags")).toBeNull();
    // A read-only note points the owner to the unified editor.
    const note = screen.getByText(/tags are set in/i);
    expect(note).toBeInTheDocument();
    expect(within(note).getByRole("link", { name: /overview/i })).toHaveAttribute(
      "href",
      "/canvases/c1",
    );
  });

  it("surfaces a gallery-toggle server rejection as an error toast", async () => {
    mockFetch({
      "GET /api/canvases/c1": () =>
        json({
          ...CANVAS,
          publicationState: "published",
          shared: true,
          currentVersionId: "v1",
          galleryListed: true,
        }),
      "PATCH /api/canvases/c1/settings": () =>
        json({ code: "NOT_PUBLISHED", message: "Publish this canvas before listing it." }, 409),
    });
    const user = userEvent.setup();
    renderShare();

    await user.click(
      await screen.findByRole("switch", { name: /allow others to use as a template/i }),
    );
    expect(
      await screen.findByText(/publish this canvas before listing it in the gallery/i),
    ).toBeInTheDocument();
  });
});
