import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../components/ConfirmDialog.js";

describe("ConfirmDialog", () => {
  it("uses a verb-labeled action button, not 'Confirm'", () => {
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={() => {}}
        title="Roll back to version 1?"
        actionLabel="Roll back"
      />,
    );
    expect(screen.getByRole("button", { name: "Roll back" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^confirm$/i })).not.toBeInTheDocument();
  });

  it("blocks Escape and backdrop dismissal while recovery is pending", () => {
    const onClose = vi.fn();
    const props = {
      open: true,
      onClose,
      onConfirm: vi.fn(),
      title: "Restore version 1?",
      actionLabel: "Replace draft",
    };
    const { rerender } = render(<ConfirmDialog {...props} loading />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(screen.getByRole("presentation"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    rerender(<ConfirmDialog {...props} loading={false} />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
