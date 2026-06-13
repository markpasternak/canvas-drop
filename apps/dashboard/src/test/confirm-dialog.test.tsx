import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
