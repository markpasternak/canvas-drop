import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddUsersPanel } from "../components/AddUsersPanel.js";
import { ToastProvider } from "../components/Toast.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(url, "http://localhost").pathname;
      return handlers[`${method} ${path}`]?.() ?? json({ error: "not_mocked" }, 500);
    }),
  );
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AddUsersPanel />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddUsersPanel", () => {
  it("confirms that a sign-in email was sent when the server reports delivery", async () => {
    mockFetch({
      "GET /api/admin/allowed-emails": () => json({ emails: [] }),
      "POST /api/admin/allowed-emails": () =>
        json({
          ok: true,
          status: "pending",
          entry: null,
          emailDelivery: { status: "sent" },
        }),
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /sign-in permits/i }));
    await user.type(await screen.findByLabelText(/email to permit/i), "person@example.com");
    await user.click(screen.getByRole("button", { name: /add permit/i }));

    expect(await screen.findByText("Sign-in permit added. Email sent")).toBeInTheDocument();
  });
});
