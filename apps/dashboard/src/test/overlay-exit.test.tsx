import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../components/Dialog.js";
import { ToastProvider, useToast } from "../components/Toast.js";
import { EXIT_MS } from "../lib/use-exit-transition.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Stub matchMedia so `(prefers-reduced-motion: reduce)` reports `reduce`. */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduce : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function DialogHarness({ open }: { open: boolean }) {
  return (
    <Dialog open={open} onClose={() => {}} title="Settings">
      <p>Body</p>
    </Dialog>
  );
}

describe("overlay exit motion", () => {
  it("Dialog: marks data-state=closed, then unmounts after the exit delay", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const { rerender } = render(<DialogHarness open />);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "open");

    // Close: the panel stays mounted but flips to data-state="closed" (exit anim).
    rerender(<DialogHarness open={false} />);
    const closing = screen.getByRole("dialog");
    expect(closing).toHaveAttribute("data-state", "closed");

    // It unmounts only after the exit delay elapses.
    act(() => vi.advanceTimersByTime(EXIT_MS - 1));
    expect(screen.queryByRole("dialog")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Dialog: under reduced-motion the exit is instant (no lingering element)", () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    const { rerender } = render(<DialogHarness open />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(<DialogHarness open={false} />);
    // No delay needed: the element is gone synchronously (animation suppressed).
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Toast: dismisses with an exit phase (data-state=closed) then unmounts", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);

    function Pusher() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => toast("Saved")}>
          push
        </button>
      );
    }
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "push" }));
    const toast = screen.getByText("Saved");
    expect(toast).toHaveAttribute("data-state", "open");

    // After the visible dwell, it enters the exit phase but is still mounted.
    act(() => vi.advanceTimersByTime(2600));
    expect(screen.getByText("Saved")).toHaveAttribute("data-state", "closed");

    // It unmounts after the exit delay.
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
