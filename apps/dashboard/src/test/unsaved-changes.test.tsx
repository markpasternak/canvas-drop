import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUnsavedChanges } from "../lib/use-unsaved-changes.js";

function harness(saveBeforeLeave?: () => Promise<boolean>) {
  function Editor() {
    const blocker = useUnsavedChanges({ dirty: true, saveBeforeLeave });
    return (
      <>
        <p>Unsaved document</p>
        <Link to="/new">Navigate</Link>
        {blocker.status === "blocked" && (
          <>
            <button type="button" onClick={blocker.reset}>
              Keep editing
            </button>
            <button type="button" onClick={blocker.proceed}>
              Discard and leave
            </button>
          </>
        )}
      </>
    );
  }
  const root = createRootRoute({ component: Outlet });
  const edit = createRoute({ getParentRoute: () => root, path: "/", component: Editor });
  const next = createRoute({
    getParentRoute: () => root,
    path: "/new",
    component: () => <p>Destination</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([edit, next]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: isolated test router differs from registered app routes
  render(<RouterProvider router={router as any} />);
  return router;
}

describe("unsaved navigation protection", () => {
  it("keeps dirty content mounted until explicit discard, with a keep-editing exit", async () => {
    harness();
    fireEvent.click(await screen.findByRole("link", { name: "Navigate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Keep editing" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Unsaved document")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Navigate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByText("Destination")).toBeInTheDocument();
  });

  it("waits for an acknowledged save before allowing navigation", async () => {
    let finish!: (saved: boolean) => void;
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    harness(save);
    fireEvent.click(await screen.findByRole("link", { name: "Navigate" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(screen.getByText("Unsaved document")).toBeInTheDocument();
    expect(screen.queryByText("Destination")).not.toBeInTheDocument();
    await act(async () => finish(true));
    expect(await screen.findByText("Destination")).toBeInTheDocument();
  });

  it("blocks on a rejected save instead of discarding the view", async () => {
    harness(async () => {
      throw new Error("offline");
    });
    fireEvent.click(await screen.findByRole("link", { name: "Navigate" }));
    expect(await screen.findByRole("button", { name: "Keep editing" })).toBeInTheDocument();
    expect(screen.getByText("Unsaved document")).toBeInTheDocument();
    expect(screen.queryByText("Destination")).not.toBeInTheDocument();
  });
});
