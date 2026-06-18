import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchInput } from "../components/SearchInput.js";

describe("SearchInput", () => {
  it("renders a searchbox with the given accessible name and placeholder", () => {
    render(
      <SearchInput
        value=""
        onChange={() => {}}
        aria-label="Search your canvases"
        placeholder="Search your canvases"
      />,
    );
    const box = screen.getByRole("searchbox", { name: "Search your canvases" });
    expect(box).toBeInTheDocument();
    expect(box).toHaveAttribute("type", "search");
    expect(box).toHaveAttribute("placeholder", "Search your canvases");
  });

  it("renders a decorative leading magnifier icon", () => {
    const { container } = render(<SearchInput value="" onChange={() => {}} aria-label="Search" />);
    // The phosphor icon renders an aria-hidden <svg> inside the wrapper.
    const icon = container.querySelector("svg[aria-hidden='true']");
    expect(icon).not.toBeNull();
  });

  it("fires onChange with the typed value", async () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} aria-label="Search" />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "hi");
    expect(onChange).toHaveBeenCalled();
    // controlled input stays empty (no value prop wiring in the test), so each
    // keystroke fires onChange with the single character typed.
    expect(onChange).toHaveBeenCalledWith("h");
    expect(onChange).toHaveBeenCalledWith("i");
  });

  it("reflects the controlled value", () => {
    render(<SearchInput value="report" onChange={() => {}} aria-label="Search" />);
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("report");
  });
});
