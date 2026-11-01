import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoldButton } from "../components/HoldButton.js";
import { ReadError } from "../components/ReadError.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { Skeleton } from "../components/Skeleton.js";
import { InlineNotice } from "../components/Surface.js";
import { ToastProvider, useToast } from "../components/Toast.js";

afterEach(() => vi.useRealTimers());

describe("shared UX recovery and accessibility", () => {
  it("offers native confirmation without timing and prevents a trailing hold from firing twice", () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    render(<HoldButton onComplete={complete}>Hold to delete</HoldButton>);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Hold to delete" }), { button: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Confirm without holding" }));
    act(() => vi.advanceTimersByTime(2000));
    expect(complete).toHaveBeenCalledOnce();
  });

  it("cancels a pending hold when permission/loading disables it", () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    const { rerender } = render(<HoldButton onComplete={complete}>Hold to delete</HoldButton>);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Hold to delete" }), { button: 0 });
    act(() => vi.advanceTimersByTime(500));
    rerender(
      <HoldButton onComplete={complete} disabled>
        Hold to delete
      </HoldButton>,
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(complete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm without holding" })).toBeDisabled();
  });

  it("keeps distinct errors through success bursts and time until explicitly dismissed", () => {
    vi.useFakeTimers();
    function Actions() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast("Save failed", "error")}>
            Fail
          </button>
          <button type="button" onClick={() => toast("Copied")}>
            Copy
          </button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Actions />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    expect(
      screen.getAllByRole("button", { name: "Dismiss notification: Save failed" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification: Save failed" }));
    expect(screen.getByRole("alert")).not.toHaveTextContent("Save failed");
  });

  it("focuses the selected section and retains the fragment and history metadata", () => {
    window.history.replaceState({ preserved: true }, "", "/");
    const select = vi.fn();
    render(
      <>
        <SettingsNav
          sections={[{ id: "protection", label: "Protection" }]}
          active=""
          onSelect={select}
        />
        <section id="protection">
          <h2>Protection settings</h2>
          <input aria-label="Expiry" />
        </section>
      </>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Protection" }));
    expect(document.activeElement).toBe(document.getElementById("protection"));
    expect(window.location.hash).toBe("#protection");
    expect(window.history.state).toEqual({ preserved: true });
    expect(select).toHaveBeenCalledWith("protection");
    window.history.replaceState(null, "", "/");
  });

  it("announces dynamic errors and provides retry without announcing static guidance", () => {
    const retry = vi.fn();
    render(
      <>
        <InlineNotice>Static guidance</InlineNotice>
        <ReadError title="Couldn't load grants" onRetry={retry}>
          Access is unknown until this loads.
        </ReadError>
        <Skeleton label="Loading canvases" />
      </>,
    );
    expect(screen.getByText("Static guidance")).not.toHaveAttribute("role");
    expect(screen.getByRole("alert")).toHaveTextContent("Access is unknown");
    expect(screen.getByRole("status")).toHaveTextContent("Loading canvases");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
