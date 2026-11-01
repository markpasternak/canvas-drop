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

  it("pastes all complete tags in one update and retains the final fragment", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={["existing"]} onChange={onChange} />);

    const input = screen.getByLabelText("Tags");
    await user.click(input);
    await user.paste(" Alpha,beta,ALPHA,tail");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(["existing", "alpha", "beta"]);
    expect(input).toHaveValue("tail");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["existing", "alpha", "beta", "tail"]);
  });

  it("deduplicates a pasted batch and respects the combined tag limit", async () => {
    const initial = Array.from({ length: MAX_TAGS - 2 }, (_, i) => `t${i}`);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host initial={initial} onChange={onChange} />);

    const input = screen.getByLabelText("Tags");
    await user.click(input);
    await user.paste("one,ONE,t1,two,extra,");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([...initial, "one", "two"]);
    expect(input).toBeDisabled();
  });

  it("preserves a pasted batch longer than 50 characters while validating each tag", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Host onChange={onChange} />);
    const input = screen.getByLabelText("Tags");
    const first = "a".repeat(30);
    const second = "b".repeat(30);
    await user.click(input);
    await user.paste(`${first},${second}`);
    expect(input).toHaveValue(second);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([first, second]);
    await user.paste(`${"x".repeat(51)},valid,`);
    expect(onChange).toHaveBeenLastCalledWith([first, second, "valid"]);
    expect(screen.getByRole("alert")).toHaveTextContent("Longer tags haven’t been added");
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
    // Validate each tag rather than truncating a whole paste before parsing it.
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
