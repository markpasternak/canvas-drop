import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagFilter, type TagFilterProps } from "../components/TagFilter.js";

const TAGS = ["alpha", "beta", "gamma", "delta"];

/** Render a controlled TagFilter whose selection lives in a tiny state harness, so
 *  toggling reflects back like the real `?tag=` round-trip. Returns the spy. */
function renderControlled(props?: Partial<TagFilterProps>) {
  const onChange = vi.fn();
  function Harness() {
    const [selected, setSelected] = useState<string[]>([...(props?.selected ?? [])]);
    return (
      <TagFilter
        availableTags={props?.availableTags ?? TAGS}
        selected={selected}
        onChange={(next) => {
          onChange(next);
          setSelected(next);
        }}
        label={props?.label}
      />
    );
  }
  render(<Harness />);
  return { onChange };
}

const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /filter by tag/i }));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TagFilter — selection", () => {
  it("lists the available tags when opened", async () => {
    const user = userEvent.setup();
    renderControlled();
    await openPanel(user);
    const listbox = screen.getByRole("listbox");
    for (const tag of TAGS) {
      expect(within(listbox).getByRole("option", { name: new RegExp(tag) })).toBeInTheDocument();
    }
  });

  it("filters the option list by the search field", async () => {
    const user = userEvent.setup();
    renderControlled();
    await openPanel(user);
    await user.type(screen.getByRole("combobox"), "al");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAccessibleName(/alpha/);
  });

  it("toggles selection and reports the full multi-selection via onChange", async () => {
    const user = userEvent.setup();
    const { onChange } = renderControlled();
    await openPanel(user);
    await user.click(screen.getByRole("option", { name: /alpha/ }));
    expect(onChange).toHaveBeenLastCalledWith(["alpha"]);
    await user.click(screen.getByRole("option", { name: /gamma/ }));
    expect(onChange).toHaveBeenLastCalledWith(["alpha", "gamma"]);
    // Re-selecting alpha removes it (toggle off).
    await user.click(screen.getByRole("option", { name: /alpha/ }));
    expect(onChange).toHaveBeenLastCalledWith(["gamma"]);
  });

  it("renders active selections as removable chips and clears them", async () => {
    const user = userEvent.setup();
    const { onChange } = renderControlled({ selected: ["alpha", "beta"] });
    const removeAlpha = screen.getByRole("button", { name: "Remove tag alpha" });
    expect(removeAlpha).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove tag beta" })).toBeInTheDocument();
    await user.click(removeAlpha);
    expect(onChange).toHaveBeenLastCalledWith(["beta"]);
  });

  it("reflects the selected state on the options (aria-selected)", async () => {
    const user = userEvent.setup();
    renderControlled({ selected: ["beta"] });
    await openPanel(user);
    expect(screen.getByRole("option", { name: /beta/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /alpha/ })).toHaveAttribute("aria-selected", "false");
  });
});

describe("TagFilter — overflow", () => {
  it("caps the option list height and scrolls (no virtualization)", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 40 }, (_, i) => `tag-${i}`);
    renderControlled({ availableTags: many });
    await openPanel(user);
    const listbox = screen.getByRole("listbox");
    // All 40 are present (no virtualization) and the list is height-capped + scrollable.
    expect(within(listbox).getAllByRole("option")).toHaveLength(40);
    expect(listbox.className).toContain("max-h-[240px]");
    expect(listbox.className).toContain("overflow-y-auto");
  });
});

describe("TagFilter — zero tags", () => {
  it("renders nothing when there are no available tags", () => {
    const { container } = render(
      <TagFilter availableTags={[]} selected={[]} onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: /filter by tag/i })).not.toBeInTheDocument();
  });
});

describe("TagFilter — keyboard / focus management", () => {
  it("opening focuses the search field", async () => {
    const user = userEvent.setup();
    renderControlled();
    await openPanel(user);
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("Esc closes and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderControlled();
    await openPanel(user);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // Focus returns to the trigger immediately; the panel unmounts after its exit
    // transition (useExitTransition), so wait for it to leave the DOM.
    expect(screen.getByRole("button", { name: /filter by tag/i })).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  });

  it("arrow keys move the active option and Enter toggles it", async () => {
    const user = userEvent.setup();
    const { onChange } = renderControlled();
    await openPanel(user);
    // Index starts at 0 (alpha). ArrowDown -> beta, ArrowDown -> gamma.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const gamma = screen.getByRole("option", { name: /gamma/ });
    expect(gamma).toHaveAttribute("id");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-activedescendant", gamma.id);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["gamma"]);
  });

  it("removing the last active chip returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderControlled({ selected: ["alpha"] });
    const remove = screen.getByRole("button", { name: "Remove tag alpha" });
    await user.click(remove);
    expect(screen.getByRole("button", { name: /filter by tag/i })).toHaveFocus();
  });
});

describe("TagFilter — responsive variant", () => {
  it("renders the bottom-sheet variant on a narrow viewport (matchMedia default)", async () => {
    // The test setup stubs matchMedia to matches:false, so useMediaQuery("min-width:640px")
    // is false -> the narrow (bottom-sheet) branch renders.
    const user = userEvent.setup();
    renderControlled();
    await openPanel(user);
    expect(screen.getByTestId("tag-filter-panel")).toHaveAttribute("data-variant", "sheet");
  });

  it("renders the floating popover variant on a wide viewport", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("640"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    const user = userEvent.setup();
    renderControlled();
    await openPanel(user);
    expect(screen.getByTestId("tag-filter-panel")).toHaveAttribute("data-variant", "popover");
  });
});
