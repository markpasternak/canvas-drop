import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu, ActionMenuItem } from "../components/ActionMenu.js";
import { CanvasGridCard, cardNameLinkClass } from "../components/CanvasGridCard.js";
import { CanvasListRow } from "../components/CanvasListRow.js";

/**
 * The unified cover-fills-card + shared list row (UX-sweep R2). One grid card and
 * one row drive BOTH the owner list and the gallery; the only difference between the
 * surfaces is which slots the caller fills. These tests pin the shared structure:
 * name + status + tags + description on the card, the truncation tooltip, and the
 * raised overflow that must NOT trigger the whole-card navigation.
 */

const LONG_DESC =
  "A long description that runs well past one line and is clamped to two with an ellipsis so it never overflows the cover, while the full text stays available via the title tooltip.";

function renderGridCard(over: Partial<React.ComponentProps<typeof CanvasGridCard>> = {}) {
  const onActivate = vi.fn();
  const utils = render(
    <ul>
      <CanvasGridCard
        seed="cv1"
        title="Budget chart"
        status="published"
        onActivate={onActivate}
        nameLink={
          <a href="#x" className={cardNameLinkClass} aria-label="Open Budget chart">
            Budget chart
          </a>
        }
        badges={<span>Published</span>}
        tags={["charts", "finance", "internal", "extra"]}
        description={LONG_DESC}
        actions={
          <ActionMenu label="More actions for Budget chart">
            <ActionMenuItem onSelect={() => {}}>Copy link</ActionMenuItem>
          </ActionMenu>
        }
        {...over}
      />
    </ul>,
  );
  return { onActivate, container: utils.container };
}

describe("CanvasGridCard — the unified cover-fills-card", () => {
  it("renders the name, a status badge, tags (capped) and the description", () => {
    renderGridCard();
    // The name is the single accessible affordance.
    expect(screen.getByRole("link", { name: "Open Budget chart" })).toBeInTheDocument();
    // Status badge shows.
    expect(screen.getAllByText("Published").length).toBeGreaterThan(0);
    // First three tags render; the fourth collapses into a "+1" overflow chip.
    expect(screen.getByText("charts")).toBeInTheDocument();
    expect(screen.getByText("finance")).toBeInTheDocument();
    expect(screen.getByText("internal")).toBeInTheDocument();
    expect(screen.queryByText("extra")).toBeNull();
    expect(screen.getByText("+1")).toBeInTheDocument();
    // Description renders.
    expect(screen.getByText(LONG_DESC)).toBeInTheDocument();
  });

  it("clamps a long description and exposes the full text via a tooltip (title attr)", () => {
    renderGridCard();
    const desc = screen.getByText(LONG_DESC);
    expect(desc.className).toContain("line-clamp-2");
    expect(desc).toHaveAttribute("title", LONG_DESC);
  });

  it("the whole card navigates, but clicking the overflow menu does NOT navigate", async () => {
    const { onActivate } = renderGridCard();
    // Opening the overflow menu must not trigger the card-level navigation.
    await userEvent.click(screen.getByRole("button", { name: "More actions for Budget chart" }));
    expect(onActivate).not.toHaveBeenCalled();
    // The menu opened (its item is visible).
    expect(await screen.findByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();

    // Clicking a genuinely non-interactive region (the card <li>) navigates.
    const card = screen.getByRole("link", { name: "Open Budget chart" }).closest("li");
    if (!card) throw new Error("card <li> not found");
    await userEvent.click(card);
    expect(onActivate).toHaveBeenCalled();
  });

  it("renders tags as clickable filter pills when onTagClick is given (gallery)", async () => {
    const onTagClick = vi.fn();
    renderGridCard({ onTagClick });
    await userEvent.click(screen.getByRole("button", { name: "charts" }));
    expect(onTagClick).toHaveBeenCalledWith("charts");
  });

  it("the cover stays aria-hidden (the name is the accessible label)", () => {
    const { container } = render(
      <ul>
        <CanvasGridCard
          seed="cv2"
          title="X"
          onActivate={() => {}}
          nameLink={
            <a href="#x" className={cardNameLinkClass} aria-label="Open X">
              X
            </a>
          }
        />
      </ul>,
    );
    // The generative cover (no preview) is rendered aria-hidden.
    expect(container.querySelector("[aria-hidden]")).not.toBeNull();
  });

  it("renders the cover in PURE-background mode — no baked-in title/marker (no duplicate title)", () => {
    const { container } = renderGridCard();
    // The cover is the seeded mesh in plain mode: no baked title text, no type/status markers.
    expect(container.querySelector("[data-cover-plain]")).not.toBeNull();
    expect(container.querySelector("[data-cover-type]")).toBeNull();
    expect(container.querySelector("[data-cover-status]")).toBeNull();
    // The title is printed exactly ONCE — in the overlay name link, not also in the cover.
    expect(screen.getAllByText("Budget chart")).toHaveLength(1);
  });

  it("backs the overlaid text + actions on LOCAL translucent surfaces (readability on any preview)", () => {
    const { container } = renderGridCard();
    // The bottom safe-zone panel + the actions pill are frosted translucent surfaces
    // (backdrop-blur on a semi-opaque fill) so text reads on bright/dark/busy covers.
    const frosted = container.querySelectorAll(".backdrop-blur-md");
    // At least the bottom content panel and the top-right actions surface.
    expect(frosted.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the actions subordinate — the name link is the a11y-primary control, not the actions", () => {
    renderGridCard();
    const link = screen.getByRole("link", { name: "Open Budget chart" });
    const actions = screen.getByRole("button", { name: "More actions for Budget chart" });
    // The name link is the labelled affordance and sits in the bottom safe zone; the
    // actions are a quiet top-right cluster, not the primary control. DOM order: the
    // actions row precedes the bottom content, but the name carries the label + the
    // stretched ::after hit area (cardNameLinkClass) so it is the primary affordance.
    expect(link.className).toContain("after:inset-0");
    expect(actions.closest("[aria-label]")).not.toBe(link);
  });

  it("renders in both light and dark mode (theme-aware frame, image-borne overlay)", () => {
    for (const theme of ["light", "dark"] as const) {
      const { container, unmount } = render(
        <div data-theme={theme}>
          <ul>
            <CanvasGridCard
              seed="cv-theme"
              title="Themed"
              status="published"
              onActivate={() => {}}
              nameLink={
                <a href="#t" className={cardNameLinkClass} aria-label="Open Themed">
                  Themed
                </a>
              }
              description="Reads in both modes."
            />
          </ul>
        </div>,
      );
      expect(screen.getByRole("link", { name: "Open Themed" })).toBeInTheDocument();
      expect(screen.getByText("Reads in both modes.")).toBeInTheDocument();
      // The frosted overlay surface is present in both themes (it rides the image).
      expect(container.querySelector(".backdrop-blur-md")).not.toBeNull();
      unmount();
    }
  });
});

describe("CanvasListRow — the shared list row (owner + gallery)", () => {
  function renderRow(over: Partial<React.ComponentProps<typeof CanvasListRow>> = {}) {
    const onActivate = vi.fn();
    render(
      <ul>
        <CanvasListRow
          seed="r1"
          onActivate={onActivate}
          nameLink={
            <a href="#r" aria-label="Open Row canvas">
              Row canvas
            </a>
          }
          meta={<span>by alice</span>}
          description="A row description"
          actions={<button type="button">Use template</button>}
          {...over}
        />
      </ul>,
    );
    return { onActivate };
  }

  it("renders the name link, meta, and description", () => {
    renderRow();
    expect(screen.getByRole("link", { name: "Open Row canvas" })).toBeInTheDocument();
    expect(screen.getByText("by alice")).toBeInTheDocument();
    expect(screen.getByText("A row description")).toBeInTheDocument();
  });

  it("clicking the actions does NOT navigate; clicking the row body does", async () => {
    const { onActivate } = renderRow();
    await userEvent.click(screen.getByRole("button", { name: "Use template" }));
    expect(onActivate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("by alice"));
    expect(onActivate).toHaveBeenCalled();
  });
});
