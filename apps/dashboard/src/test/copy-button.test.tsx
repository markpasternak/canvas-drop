import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "../components/CopyButton.js";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../components/Toast.js", () => ({ useToast: () => toast }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CopyButton feedback", () => {
  it("ignores a late clipboard completion after the selected canvas changes", async () => {
    let finish!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onCopyFinished = vi.fn();
    const { rerender } = render(<CopyButton value="old-link" onCopyFinished={onCopyFinished} />);
    fireEvent.click(screen.getByRole("button"));
    rerender(<CopyButton value="new-link" onCopyFinished={onCopyFinished} />);
    await act(async () => finish());
    expect(writeText).toHaveBeenCalledWith("old-link");
    expect(screen.getByRole("button")).toHaveTextContent("Copy");
    expect(toast).not.toHaveBeenCalled();
    expect(onCopyFinished).not.toHaveBeenCalled();
  });

  it("ignores a completion after unmount", async () => {
    let finish!: () => void;
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      },
    });
    const onCopyFinished = vi.fn();
    const { unmount } = render(<CopyButton value="link" onCopyFinished={onCopyFinished} />);
    fireEvent.click(screen.getByRole("button"));
    unmount();
    await act(async () => finish());
    expect(toast).not.toHaveBeenCalled();
    expect(onCopyFinished).not.toHaveBeenCalled();
  });

  it("keeps confirmation for the latest copy and cancels earlier timers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const { rerender } = render(<CopyButton value="link" />);
    await act(async () => fireEvent.click(screen.getByRole("button")));
    expect(screen.getByRole("button")).toHaveTextContent("Copied");
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => fireEvent.click(screen.getByRole("button")));
    await act(async () => vi.advanceTimersByTime(600));
    expect(screen.getByRole("button")).toHaveTextContent("Copied");
    rerender(<CopyButton value="another-link" />);
    expect(screen.getByRole("button")).toHaveTextContent("Copy");
  });
});
