import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field, TextareaField } from "../components/Field.js";

describe.each([Field, TextareaField])("field accessible help", (Component) => {
  it("links the label to an explicit ID and preserves all help descriptions", () => {
    render(
      <>
        <p id="external">Required for publication.</p>
        <Component
          id="title"
          label="Title"
          hint="80 characters"
          description="Visible to people with access."
          aria-describedby="external"
        />
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveAttribute("id", "title");
    expect(screen.getByLabelText("Title")).toHaveAccessibleDescription(
      "Required for publication. 80 characters Visible to people with access.",
    );
  });

  it("assigns distinct label and description links without caller IDs", () => {
    render(
      <>
        <Component label="First" description="First help" />
        <Component label="Second" description="Second help" />
      </>,
    );
    expect(screen.getByLabelText("First").id).not.toBe(screen.getByLabelText("Second").id);
    expect(screen.getByLabelText("First")).toHaveAccessibleDescription("First help");
    expect(screen.getByLabelText("Second")).toHaveAccessibleDescription("Second help");
  });
});
