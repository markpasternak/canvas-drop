import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConceptBadge } from "../components/Badge.js";
import { CONCEPT_COLORS, type Concept, conceptColor } from "../components/concept-colors.js";

/**
 * The concept colour-coding contract (rebrand): the canvas-state concepts each map
 * to a stable, distinct colour, sourced from ONE shared map so the stat strip, the
 * filter chips, and the row badges can't drift. These tests pin the mapping so a
 * future edit that breaks the curated palette fails loudly.
 */

const ALL_CONCEPTS: Concept[] = [
  "active",
  "archived",
  "templates",
  "protected",
  "listed",
  "shared",
  "neverDeployed",
];

describe("concept-colors map", () => {
  it("maps every concept to a dot / text / bg class trio", () => {
    for (const concept of ALL_CONCEPTS) {
      const c = conceptColor(concept);
      expect(c.dot).toMatch(/^bg-/);
      expect(c.text).toMatch(/^text-/);
      expect(c.bg).toMatch(/^bg-/);
    }
  });

  it("pins the curated concept → colour mapping (no rainbow drift)", () => {
    expect(CONCEPT_COLORS.active.text).toBe("text-success");
    expect(CONCEPT_COLORS.templates.text).toBe("text-accent");
    expect(CONCEPT_COLORS.protected.text).toBe("text-warning");
    expect(CONCEPT_COLORS.listed.text).toBe("text-info");
    expect(CONCEPT_COLORS.shared.text).toBe("text-shared");
    // The quiet states stay neutral by design.
    expect(CONCEPT_COLORS.archived.text).toBe("text-muted");
    expect(CONCEPT_COLORS.neverDeployed.text).toBe("text-subtle");
  });

  it("gives the colour-bearing concepts visually distinct dots", () => {
    const colored: Concept[] = ["active", "templates", "protected", "listed", "shared"];
    const dots = colored.map((c) => conceptColor(c).dot);
    expect(new Set(dots).size).toBe(colored.length);
  });
});

describe("ConceptBadge", () => {
  it("renders the concept's tint and keeps the text label (colour is redundant)", () => {
    render(<ConceptBadge concept="listed">Listed</ConceptBadge>);
    const badge = screen.getByText("Listed");
    expect(badge).toHaveAttribute("data-concept", "listed");
    expect(badge.className).toContain("text-info");
    expect(badge.className).toContain("bg-info-subtle");
  });
});
