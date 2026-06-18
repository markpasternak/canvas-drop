import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoldButton } from "../components/HoldButton.js";

afterEach(() => vi.useRealTimers());

describe("HoldButton", () => {
  it("fires onComplete only after the full hold elapses", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(
      <HoldButton onComplete={onComplete} holdMs={1000}>
        Hold to delete
      </HoldButton>,
    );
    const btn = screen.getByRole("button", { name: /hold to delete/i });

    fireEvent.pointerDown(btn);
    act(() => vi.advanceTimersByTime(999));
    expect(onComplete).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("cancels when released early (a click must not delete)", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(
      <HoldButton onComplete={onComplete} holdMs={1000}>
        Hold to delete
      </HoldButton>,
    );
    const btn = screen.getByRole("button", { name: /hold to delete/i });

    fireEvent.pointerDown(btn);
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(btn);
    act(() => vi.advanceTimersByTime(2000));
    expect(onComplete).not.toHaveBeenCalled();

    // Leaving the button mid-hold also cancels.
    fireEvent.pointerDown(btn);
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerLeave(btn);
    act(() => vi.advanceTimersByTime(2000));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("arms on a held Enter/Space key exactly once despite auto-repeat", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(
      <HoldButton onComplete={onComplete} holdMs={1000}>
        Hold to delete
      </HoldButton>,
    );
    const btn = screen.getByRole("button", { name: /hold to delete/i });

    // Auto-repeat fires keydown repeatedly; the hold must arm only once.
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.keyDown(btn, { key: "Enter" });
    act(() => vi.advanceTimersByTime(1000));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("releasing a key before the hold completes cancels it", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(
      <HoldButton onComplete={onComplete} holdMs={1000}>
        Hold to delete
      </HoldButton>,
    );
    const btn = screen.getByRole("button", { name: /hold to delete/i });

    fireEvent.keyDown(btn, { key: " " });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.keyUp(btn, { key: " " });
    act(() => vi.advanceTimersByTime(2000));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("surfaces a text hold cue while holding (reduced-motion fallback) and still completes", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    const { container } = render(
      <HoldButton onComplete={onComplete} holdMs={1000}>
        Hold to delete
      </HoldButton>,
    );
    const btn = screen.getByRole("button", { name: /hold to delete/i });

    // No cue at rest.
    expect(container.querySelector(".cd-hold-cue")).toBeNull();

    fireEvent.pointerDown(btn);
    // While holding, a discrete text cue exists (CSS reveals it under
    // reduced-motion, where the sweeping fill is suppressed).
    act(() => vi.advanceTimersByTime(500));
    const cue = container.querySelector(".cd-hold-cue");
    expect(cue).not.toBeNull();
    expect(cue?.textContent).toMatch(/holding/i);

    // The hold still completes via the JS timer regardless of motion preference.
    act(() => vi.advanceTimersByTime(500));
    expect(onComplete).toHaveBeenCalledOnce();
    // Cue clears once the hold resolves.
    expect(container.querySelector(".cd-hold-cue")).toBeNull();
  });

  it("does not fire if it unmounts mid-hold", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    const { unmount } = render(
      <HoldButton onComplete={onComplete} holdMs={1000}>
        Hold to delete
      </HoldButton>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: /hold to delete/i }));
    act(() => vi.advanceTimersByTime(500));
    unmount();
    act(() => vi.advanceTimersByTime(2000));
    expect(onComplete).not.toHaveBeenCalled();
  });
});
