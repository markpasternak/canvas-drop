import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../components/Button.js";

describe("Button", () => {
  it("renders its label and is not busy by default", () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(btn).not.toBeDisabled();
  });

  it("when loading, surfaces a textual busy cue and aria-busy (not just a spinner)", () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole("button");
    // aria-busy is set for assistive tech.
    expect(btn).toHaveAttribute("aria-busy", "true");
    // A textual cue accompanies the spinner so a reduced-motion (frozen) spinner
    // is never the only busy signal. The CSS reveals this text under
    // prefers-reduced-motion; here we assert the element exists in the DOM.
    const cue = btn.querySelector(".cd-busy-text");
    expect(cue).not.toBeNull();
    expect(cue?.textContent).toMatch(/working/i);
    // The label is preserved alongside the busy cue.
    expect(btn).toHaveTextContent("Save");
    expect(btn).toBeDisabled();
  });
});
