import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Row, RowDivider, Section } from "../components/SettingsSection.js";

/**
 * The settings-section primitive renders FLAT (a hairline-divided band), not a
 * boxed card. These guard the flat treatment introduced in the canvas-detail
 * redesign (KTD1/KTD2): serif heading, no rounded/shadow card wrapper, danger
 * tone via heading color (not a red box).
 */
describe("Section (flat settings primitive)", () => {
  it("renders its title as a level-2 heading", () => {
    render(
      <Section id="general" title="General">
        <p>body</p>
      </Section>,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "General" });
    expect(heading).toBeInTheDocument();
    expect(heading.className).toContain("font-serif");
  });

  it("is flat — no rounded-xl/shadow card wrapper", () => {
    const { container } = render(
      <Section id="general" title="General">
        <p>body</p>
      </Section>,
    );
    const section = container.querySelector("section#general");
    expect(section).not.toBeNull();
    // Flat band, not a boxed card.
    expect(section?.className).not.toContain("rounded-xl");
    expect(section?.className).not.toContain("shadow");
    expect(section?.className).not.toContain("bg-surface");
    // Hairline-band rhythm + first-flush + section-nav scroll offset.
    expect(section?.className).toContain("border-t");
    expect(section?.className).toContain("first:border-t-0");
    expect(section?.className).toContain("scroll-mt-20");
  });

  it("renders optional description as muted text", () => {
    render(
      <Section id="s" title="Title" description="Some help">
        <p>body</p>
      </Section>,
    );
    expect(screen.getByText("Some help")).toBeInTheDocument();
  });

  it("danger tone colors the heading and renders its control — no red box", () => {
    const { container } = render(
      <Section id="danger" title="Danger zone" tone="danger">
        <button type="button">Delete canvas</button>
      </Section>,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "Danger zone" });
    expect(heading.className).toContain("text-danger");
    expect(screen.getByRole("button", { name: "Delete canvas" })).toBeInTheDocument();
    const section = container.querySelector("section#danger");
    // No red bordered box (danger is heading-only).
    expect(section?.className).not.toContain("border-danger");
    expect(section?.className).not.toContain("rounded-xl");
  });

  it("still exports Row and RowDivider with their behavior intact", () => {
    render(
      <Section id="s" title="Title">
        <Row title="A setting" description="explainer">
          <button type="button">Act</button>
        </Row>
        <RowDivider />
      </Section>,
    );
    expect(screen.getByText("A setting")).toBeInTheDocument();
    expect(screen.getByText("explainer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Act" })).toBeInTheDocument();
  });
});
