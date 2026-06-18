import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tag } from "../components/Tag.js";

describe("Tag", () => {
  it("renders a non-interactive chip by default", () => {
    render(<Tag>design</Tag>);
    expect(screen.getByText("design")).toBeInTheDocument();
    // No onClick → a plain element, not a button.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("applies an optional title (the overflow tooltip)", () => {
    render(
      <Tag tone="subtle" title="2 more tags">
        +2
      </Tag>,
    );
    expect(screen.getByText("+2")).toHaveAttribute("title", "2 more tags");
  });

  it("renders as a button and fires onClick when interactive", async () => {
    const onClick = vi.fn();
    render(
      <Tag size="sm" onClick={onClick}>
        report
      </Tag>,
    );
    const button = screen.getByRole("button", { name: "report" });
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
