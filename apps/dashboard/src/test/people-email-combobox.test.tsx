import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PeopleEmailCombobox } from "../components/PeopleEmailCombobox.js";
import type { PersonSuggestion } from "../lib/api.js";

const HUGO: PersonSuggestion = {
  id: "u2",
  email: "hugo.martensson@seenthis.se",
  name: "Hugo Martensson",
};

function Host({
  suggestions = [HUGO],
  onSubmit = vi.fn(),
}: {
  suggestions?: PersonSuggestion[];
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <PeopleEmailCombobox
      label="Person's email"
      placeholder="colleague@example.com"
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      suggestions={suggestions}
      searchEnabled={value.trim().length >= 2}
      searching={false}
    />
  );
}

describe("PeopleEmailCombobox", () => {
  it("renders app-styled people suggestions and selects one", async () => {
    const user = userEvent.setup();
    render(<Host />);

    const input = screen.getByRole("combobox", { name: "Person's email" });
    await user.type(input, "hu");

    const option = await screen.findByRole("option", {
      name: /Hugo Martensson hugo\.martensson@seenthis\.se/,
    });
    await user.click(option);

    expect(input).toHaveValue("hugo.martensson@seenthis.se");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("commits a mouse selection before the menu can close", async () => {
    const user = userEvent.setup();
    render(<Host />);

    const input = screen.getByRole("combobox", { name: "Person's email" });
    await user.type(input, "hu");

    const option = await screen.findByRole("option", {
      name: /Hugo Martensson hugo\.martensson@seenthis\.se/,
    });
    fireEvent.pointerDown(option);

    expect(input).toHaveValue("hugo.martensson@seenthis.se");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("keeps free-form email invite submission on Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Host suggestions={[]} onSubmit={onSubmit} />);

    const input = screen.getByRole("combobox", { name: "Person's email" });
    await user.type(input, "external@example.com{Enter}");

    expect(input).toHaveValue("external@example.com");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
