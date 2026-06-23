import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type FilterOption, FilterSelect } from "../components/Filters.js";

const OPTIONS: FilterOption[] = [
  { value: "all", label: "All access" },
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
];

function Harness({
  disabled = false,
  onChange = vi.fn(),
}: {
  disabled?: boolean;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState("all");
  return (
    <FilterSelect
      label="Access"
      options={OPTIONS}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("FilterSelect", () => {
  it("supports arrow navigation and Enter selection", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    const trigger = screen.getByRole("combobox", { name: "Access" });
    trigger.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("private");
    expect(trigger).toHaveTextContent("Private");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports Home/End movement, Space selection, Escape close, and Tab close", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole("combobox", { name: "Access" });

    trigger.focus();
    await user.keyboard("{ArrowDown}{End} ");
    expect(onChange).toHaveBeenCalledWith("public");
    expect(trigger).toHaveTextContent("Public");

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());

    await user.click(trigger);
    expect(within(screen.getByRole("listbox")).getByText("Public")).toBeInTheDocument();
    await user.tab();
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  });

  it("does not open while disabled", async () => {
    const user = userEvent.setup();
    render(<Harness disabled />);
    const trigger = screen.getByRole("combobox", { name: "Access" });

    await user.click(trigger);
    trigger.focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
