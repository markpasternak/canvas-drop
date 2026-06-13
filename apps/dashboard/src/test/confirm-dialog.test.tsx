import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("type-to-confirm keeps the action disabled until the phrase matches", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        title="Delete this canvas?"
        actionLabel="Delete canvas"
        destructive
        confirmPhrase="quiet-otter"
      />,
    );
    const action = screen.getByRole("button", { name: "Delete canvas" });
    expect(action).toBeDisabled();

    await user.type(screen.getByRole("textbox"), "wrong");
    expect(action).toBeDisabled();

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "quiet-otter");
    expect(action).toBeEnabled();
    await user.click(action);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
