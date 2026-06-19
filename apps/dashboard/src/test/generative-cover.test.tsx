import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  COVER_HUE_ANCHORS,
  coverStyle,
  coverType,
  GenerativeCover,
} from "../components/GenerativeCover.js";

/** Pull every `oklch(... <hue>)` hue out of a style's colour + gradient layers. */
function huesOf(style: ReturnType<typeof coverStyle>): number[] {
  const text = `${style.backgroundColor ?? ""} ${String(style.backgroundImage ?? "")}`;
  return [...text.matchAll(/oklch\([^)]*?\s([\d.]+)\)/g)].map((m) => Number(m[1]));
}

describe("coverStyle (plan 004 / preview-parity U3)", () => {
  it("is deterministic — same seed yields the same art", () => {
    expect(coverStyle("canvas-abc")).toEqual(coverStyle("canvas-abc"));
  });

  it("differs across seeds", () => {
    expect(coverStyle("canvas-abc")).not.toEqual(coverStyle("canvas-xyz"));
  });

  it("is never blank — always a colour plus a layered gradient", () => {
    const s = coverStyle("anything");
    expect(s.backgroundColor).toBeTruthy();
    expect(String(s.backgroundImage)).toContain("radial-gradient");
  });

  it("draws hues from the curated on-brand band (not an arbitrary rainbow)", () => {
    const JITTER = 7; // matches HUE_JITTER in GenerativeCover
    // For a spread of seeds, every hue must sit within ±JITTER of a curated anchor.
    for (let i = 0; i < 200; i++) {
      for (const hue of huesOf(coverStyle(`canvas-${i}`))) {
        const nearest = Math.min(...COVER_HUE_ANCHORS.map((a) => Math.abs(a - hue)));
        expect(nearest).toBeLessThanOrEqual(JITTER);
      }
    }
  });

  it("centres the band on the teal accent (~200) with a warm amber complement (~70)", () => {
    expect(COVER_HUE_ANCHORS).toContain(200);
    expect(COVER_HUE_ANCHORS).toContain(70);
  });
});

describe("coverType (UX-sweep U6)", () => {
  it("maps to the concept taxonomy by priority: template > listed > protected > canvas", () => {
    expect(coverType({ templatable: true, listed: true, protectedByPassword: true })).toBe(
      "templates",
    );
    expect(coverType({ listed: true, protectedByPassword: true })).toBe("listed");
    expect(coverType({ protectedByPassword: true })).toBe("protected");
    expect(coverType({})).toBe("canvas");
  });
});

describe("GenerativeCover content-aware fallback (UX-sweep U6)", () => {
  it("overlays the title and a type/status marker on the seeded mesh", () => {
    const { getByText, container } = render(
      <GenerativeCover seed="cv1" title="Quarterly Report" type="listed" status="draft" />,
    );
    expect(getByText("Quarterly Report")).toBeTruthy();
    expect(container.querySelector("[data-cover-type='listed']")).not.toBeNull();
    expect(container.querySelector("[data-cover-status='draft']")).not.toBeNull();
    // Background mesh is preserved.
    expect(container.firstElementChild?.getAttribute("style")).toContain("radial-gradient");
  });

  it("renders visibly distinct covers for canvases differing only in title/type/status", () => {
    const a = render(
      <GenerativeCover seed="same" title="Alpha" type="templates" status="published" />,
    );
    const b = render(<GenerativeCover seed="same" title="Beta" type="protected" status="draft" />);
    // Same seed → same mesh, but the overlaid content differs, so the markup differs.
    expect(a.container.innerHTML).not.toBe(b.container.innerHTML);
    expect(a.getByText("Alpha")).toBeTruthy();
    expect(b.getByText("Beta")).toBeTruthy();
    expect(a.container.querySelector("[data-cover-type='templates']")).not.toBeNull();
    expect(b.container.querySelector("[data-cover-type='protected']")).not.toBeNull();
  });

  it("clamps a long title to 2 lines with ellipsis (no overflow)", () => {
    const longTitle =
      "An extraordinarily long canvas title that would otherwise wrap to many lines and overflow the fixed cover box entirely";
    const { getByText } = render(<GenerativeCover seed="cv1" title={longTitle} />);
    const titleEl = getByText(longTitle);
    expect(titleEl.className).toContain("line-clamp-2");
  });

  it("keeps the mesh deterministic for a given id regardless of content", () => {
    const x = render(<GenerativeCover seed="fixed-id" title="One" type="canvas" />);
    const y = render(<GenerativeCover seed="fixed-id" title="Two" type="templates" />);
    const styleX = x.container.firstElementChild?.getAttribute("style");
    const styleY = y.container.firstElementChild?.getAttribute("style");
    // The background style is seed-derived only, so it is identical across content.
    expect(styleX).toBe(styleY);
  });

  it("renders a generic label when no title is given and stays aria-hidden", () => {
    const { getByText, container } = render(<GenerativeCover seed="cv1" />);
    expect(getByText("Untitled canvas")).toBeTruthy();
    expect(container.firstElementChild?.getAttribute("aria-hidden")).not.toBeNull();
  });
});

describe("GenerativeCover pure-background mode (UX-sweep `plain`)", () => {
  it("suppresses ALL baked-in text/markers — just the seeded mesh", () => {
    const { container, queryByText } = render(
      <GenerativeCover seed="cv1" title="Quarterly Report" type="listed" status="draft" plain />,
    );
    // No title, no type marker, no status marker baked into the cover.
    expect(queryByText("Quarterly Report")).toBeNull();
    expect(container.querySelector("[data-cover-type]")).toBeNull();
    expect(container.querySelector("[data-cover-status]")).toBeNull();
    // It IS the pure-background variant, and the seeded mesh is preserved.
    const root = container.firstElementChild;
    expect(root?.getAttribute("data-cover-plain")).not.toBeNull();
    expect(root?.getAttribute("style")).toContain("radial-gradient");
    expect(root?.getAttribute("aria-hidden")).not.toBeNull();
  });

  it("keeps the same seeded mesh as the content-aware mode (plain only drops the overlay)", () => {
    const plain = render(<GenerativeCover seed="fixed" plain />);
    const aware = render(<GenerativeCover seed="fixed" title="X" type="templates" />);
    const plainStyle = plain.container.firstElementChild?.getAttribute("style");
    const awareStyle = aware.container.firstElementChild?.getAttribute("style");
    expect(plainStyle).toBe(awareStyle);
  });
});
