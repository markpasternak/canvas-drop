import { List, SquaresFour } from "@phosphor-icons/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "../components/SegmentedControl.js";

describe("SegmentedControl", () => {
  it("renders a labelled group with one button per item", () => {
    render(
      <SegmentedControl
        aria-label="Scope"
        value="active"
        onChange={() => {}}
        items={[
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
        ]}
      />,
    );
    const group = screen.getByRole("group", { name: "Scope" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archived" })).toBeInTheDocument();
  });

  it("marks only the active item with aria-pressed=true", () => {
    render(
      <SegmentedControl
        aria-label="Scope"
        value="archived"
        onChange={() => {}}
        items={[
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Archived" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("fires onChange with the clicked value", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Scope"
        value="active"
        onChange={onChange}
        items={[
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(onChange).toHaveBeenCalledWith("archived");
  });

  it("fires onChange on keyboard activation (Enter)", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Scope"
        value="active"
        onChange={onChange}
        items={[
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
        ]}
      />,
    );
    const archived = screen.getByRole("button", { name: "Archived" });
    archived.focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("archived");
  });

  it("renders counts as part of the accessible name", () => {
    render(
      <SegmentedControl
        aria-label="Scope"
        value="active"
        onChange={() => {}}
        items={[
          { value: "active", label: "Active", count: 3 },
          { value: "archived", label: "Archived", count: 1 },
        ]}
      />,
    );
    // The count is appended to the visible label, so it is part of the name.
    expect(screen.getByRole("button", { name: /Active 3/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Archived 1/ })).toBeInTheDocument();
  });

  it("uses the label as the accessible name for icon-only items", () => {
    render(
      <SegmentedControl
        aria-label="Layout"
        iconOnly
        value="list"
        onChange={() => {}}
        items={[
          { value: "list", label: "List view", icon: List },
          { value: "grid", label: "Grid view", icon: SquaresFour },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "List view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grid view" })).toBeInTheDocument();
  });

  it("does not fire onChange for a disabled item", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Mode"
        value="code"
        onChange={onChange}
        items={[
          { value: "code", label: "Code" },
          { value: "page", label: "Page text", disabled: true },
        ]}
      />,
    );
    const page = screen.getByRole("button", { name: "Page text" });
    expect(page).toBeDisabled();
    await userEvent.click(page);
    expect(onChange).not.toHaveBeenCalled();
  });
});
