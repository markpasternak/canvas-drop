/**
 * Concept colour-coding — the single source of truth that maps each canvas-state
 * concept (Active / Archived / Templates / Protected / Listed / Shared /
 * Never-deployed) to a curated, on-brand colour.
 *
 * One map, three surfaces: the summary stat strip, the filter chips, and the row
 * badges all read from here so a concept's colour can never drift between them.
 *
 * The palette is a harmonious band over the existing semantic tokens (the
 * deep-teal accent, success green, warning amber) plus two extra brand-adjacent
 * tints declared once in `tokens.css` (`--info` soft blue, `--shared` warm rose).
 * It is NOT a random rainbow — every hue sits in the teal→amber→rose family and
 * every -subtle/-fg pairing is AA-targeted in both light and dark (the tints are
 * authored in OKLCH for predictable contrast).
 *
 * Colour is always an accent, never the sole signal: every concept carries its
 * text label too, so the dots/tints are decorative-redundant and AA-compliant.
 *
 * The same module also owns the concept → icon map (phosphor), so the stat-strip
 * tiles, and any future surface that wants a per-concept glyph, draw the icon and
 * its colour from one place — they can never disagree.
 */

import {
  Archive,
  type Icon,
  ListChecks,
  Pulse,
  RocketLaunch,
  ShieldCheck,
  Stack,
  UsersThree,
} from "@phosphor-icons/react";

/** The canvas-state concepts we colour-code across the dashboard. */
export type Concept =
  | "active"
  | "archived"
  | "templates"
  | "protected"
  | "listed"
  | "shared"
  | "neverDeployed";

export interface ConceptColor {
  /** Tailwind class for a small dot / icon in the concept colour (`bg-current`-style). */
  dot: string;
  /** Tailwind class for tinted text/numerals in the concept colour. */
  text: string;
  /** Tailwind class for a soft tinted background (pairs AA with `text`). */
  bg: string;
}

/**
 * The curated concept → colour map. Reuses semantic tokens where they fit and the
 * two brand-adjacent tints (`info`, `shared`) for the rest. Neutral concepts
 * (Archived, Never-deployed) stay calm on the muted/subtle greys by design — a
 * colour band reads as meaningful only when the quiet states stay quiet.
 */
export const CONCEPT_COLORS: Record<Concept, ConceptColor> = {
  // Active → success green: the live, healthy state.
  active: { dot: "bg-success", text: "text-success", bg: "bg-success-subtle" },
  // Archived → slate/neutral: offline-but-kept, deliberately quiet.
  archived: { dot: "bg-subtle", text: "text-muted", bg: "bg-surface-raised" },
  // Templates → teal accent: the brand colour, reserved for the clone-source state.
  templates: { dot: "bg-accent", text: "text-accent", bg: "bg-accent-subtle" },
  // Protected → warning amber: a gate is in place.
  protected: { dot: "bg-warning", text: "text-warning", bg: "bg-warning-subtle" },
  // Listed → soft blue: discoverable in the gallery.
  listed: { dot: "bg-info", text: "text-info", bg: "bg-info-subtle" },
  // Shared → warm rose: reaches beyond the owner.
  shared: { dot: "bg-shared", text: "text-shared", bg: "bg-shared-subtle" },
  // Never-deployed → neutral subtle: nothing live yet, stay quiet.
  neverDeployed: { dot: "bg-subtle", text: "text-subtle", bg: "bg-surface-raised" },
};

/** Lookup helper — typed accessor so callers can't ask for an unknown concept. */
export function conceptColor(concept: Concept): ConceptColor {
  return CONCEPT_COLORS[concept];
}

/**
 * The concept → icon map (phosphor). One glyph per concept so a stat tile (or any
 * future per-concept surface) reads its icon from the same source as its colour.
 * Every concept is covered — including Listed + Shared, which the stat strip does
 * not currently show — so the map stays reusable by the chips/badges later without
 * a second lookup table to keep in sync.
 */
export const CONCEPT_ICONS: Record<Concept, Icon> = {
  // Active → Pulse: the live, beating state.
  active: Pulse,
  // Archived → Archive: boxed away but kept.
  archived: Archive,
  // Templates → Stack: the clone-source, a stack you copy from.
  templates: Stack,
  // Protected → ShieldCheck: a gate is in place.
  protected: ShieldCheck,
  // Listed → ListChecks: enumerated in the gallery.
  listed: ListChecks,
  // Shared → UsersThree: reaches beyond the owner.
  shared: UsersThree,
  // Never-deployed → RocketLaunch: not yet launched.
  neverDeployed: RocketLaunch,
};

/** Lookup helper — typed accessor for a concept's icon component. */
export function conceptIcon(concept: Concept): Icon {
  return CONCEPT_ICONS[concept];
}
