import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CollapsibleSection } from "../components/CollapsibleSection.js";

afterEach(() => localStorage.clear());

describe("CollapsibleSection", () => {
  it("shows children by default and toggles them, persisting to localStorage", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Section A" storageKey="test:a">
        <p>body content</p>
      </CollapsibleSection>,
    );
    const toggle = screen.getByRole("button", { name: /Section A/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("body content")).toBeVisible();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The region stays in the DOM (so aria-controls always resolves) but is hidden.
    expect(screen.getByText("body content")).not.toBeVisible();
    expect(localStorage.getItem("test:a")).toBe("0");
  });

  it("honors defaultOpen=false when no stored preference exists", () => {
    render(
      <CollapsibleSection title="Section B" storageKey="test:b" defaultOpen={false}>
        <p>hidden body</p>
      </CollapsibleSection>,
    );
    expect(screen.getByRole("button", { name: /Section B/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("hidden body")).not.toBeVisible();
  });

  it("reads the persisted state over defaultOpen on mount", () => {
    // Stored "open" must win even though defaultOpen is false.
    localStorage.setItem("test:c", "1");
    render(
      <CollapsibleSection title="Section C" storageKey="test:c" defaultOpen={false}>
        <p>restored body</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText("restored body")).toBeInTheDocument();
  });
});
