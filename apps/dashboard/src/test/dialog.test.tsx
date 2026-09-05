import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../components/Dialog.js";

describe("Dialog keyboard focus", () => {
  it("honors autofocus and restores the trigger when dismissed", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <Dialog open onClose={vi.fn()} title="Add file">
        <input aria-label="Filename" data-autofocus />
      </Dialog>,
    );
    expect(screen.getByRole("textbox")).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("keeps forward and reverse Tab inside when the panel initially has focus", async () => {
    render(
      <Dialog open onClose={vi.fn()} title="Review">
        <button type="button">Cancel</button>
        <button type="button">Publish</button>
      </Dialog>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Publish" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Publish" })).toHaveFocus();
    panel.focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("contains Tab while its controls are disabled during submission", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Publishing">
        <button type="button" disabled>
          Publish
        </button>
      </Dialog>,
    );
    expect(fireEvent.keyDown(document, { key: "Tab", cancelable: true })).toBe(false);
    expect(screen.getByRole("dialog")).toHaveFocus();
  });
});
