import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MAX_TAGS, TagsEditor } from "../components/TagsEditor.js";

/** Controlled host so the editor behaves like a real consumer (Overview). */
function Host({
  initial = [],
  onChange,
  suggestions,
}: {
  initial?: string[];
  onChange?: (next: string[]) => void;
  suggestions?: string[];
}) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <TagsEditor
      value={value}
      suggestions={suggestions}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("TagsEditor", () => {
  it("confirms a tag on Enter", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host onChange={onChange} />);

    await user.type(screen.getByLabelText("Tags"), "demo{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["demo"]);
    expect(screen.getByText("demo")).toBeInTheDocument();
  });

  it("confirms a tag on comma", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host onChange={onChange} />);

    await user.type(screen.getByLabelText("Tags"), "alpha,");
    expect(onChange).toHaveBeenLastCalledWith(["alpha"]);
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("trims and lowercases on confirm", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host onChange={onChange} />);

    await user.type(screen.getByLabelText("Tags"), "  MixedCase  {Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["mixedcase"]);
  });

  it("removes a tag via its × control", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={["keep", "drop"]} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Remove tag drop" }));
    expect(onChange).toHaveBeenLastCalledWith(["keep"]);
    expect(screen.queryByText("drop")).not.toBeInTheDocument();
  });

  it("ignores duplicate tags (deduped against existing)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={["one"]} onChange={onChange} />);

    await user.type(screen.getByLabelText("Tags"), "ONE{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects a tag longer than 50 chars (consistent with the server schema)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host onChange={onChange} />);

    const tooLong = "x".repeat(51);
    const input = screen.getByLabelText("Tags") as HTMLInputElement;
    // The input enforces maxLength=50; even forcing 51 chars via a comma split is rejected.
    await user.type(input, `${tooLong},`);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("blocks adding beyond 20 tags and disables the input at the limit", () => {
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    render(<Host initial={full} />);

    const input = screen.getByLabelText("Tags") as HTMLInputElement;
    expect(input).toBeDisabled();
    expect(input.placeholder).toMatch(/limit reached/i);
  });

  it("offers existing tags as autocomplete suggestions", () => {
    render(<Host suggestions={["existing-a", "existing-b"]} />);
    // Suggestions render as <datalist> options the input is wired to via its `list` attr.
    const listId = screen.getByLabelText("Tags").getAttribute("list");
    expect(listId).toBeTruthy();
    const datalist = document.getElementById(listId ?? "") as HTMLDataListElement;
    const values = [...datalist.options].map((o) => o.value);
    expect(values).toEqual(["existing-a", "existing-b"]);
  });
});
