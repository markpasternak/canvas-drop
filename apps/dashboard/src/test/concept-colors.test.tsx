import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConceptBadge } from "../components/Badge.js";
import {
  CONCEPT_COLORS,
  CONCEPT_ICONS,
  type Concept,
  conceptColor,
  conceptIcon,
} from "../components/concept-colors.js";

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

describe("concept-icons map", () => {
  it("maps every concept to a renderable icon component", () => {
    for (const concept of ALL_CONCEPTS) {
      const Icon = conceptIcon(concept);
      expect(Icon).toBeDefined();
      // Phosphor icons are forwardRef components — callable/renderable references.
      expect(["function", "object"]).toContain(typeof Icon);
    }
    // The map covers exactly the concept set (including Listed + Shared, which the
    // stat strip doesn't show but the map keeps reusable).
    expect(Object.keys(CONCEPT_ICONS).sort()).toEqual([...ALL_CONCEPTS].sort());
  });

  it("gives each concept its own distinct icon (no glyph reuse)", () => {
    const icons = ALL_CONCEPTS.map((c) => conceptIcon(c));
    expect(new Set(icons).size).toBe(ALL_CONCEPTS.length);
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
