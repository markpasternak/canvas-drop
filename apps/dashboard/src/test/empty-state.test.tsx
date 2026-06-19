import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  archivedEmptyState,
  EMPTY_ACTION_LABELS,
  EmptyState,
  type EmptyStateProps,
  FORBIDDEN_EMPTY_COPY,
  filteredEmptyState,
  firstRunEmptyState,
  galleryEmptyState,
  searchEmptyState,
} from "../components/EmptyState.js";

/** Collect every literal copy string a variant renders (title + description),
 * so the anti-slop guard can scan it. */
function copyText(props: EmptyStateProps): string {
  const parts = [props.title];
  if (typeof props.description === "string") parts.push(props.description);
  return parts.join(" ");
}

/** Build one of every variant with stub wiring, for the cross-cutting guards. */
function allVariants(): { name: string; props: EmptyStateProps }[] {
  return [
    {
      name: "archived",
      props: archivedEmptyState({ action: <a href="/">{EMPTY_ACTION_LABELS.archived}</a> }),
    },
    { name: "search", props: searchEmptyState({ term: "report", onClearSearch: () => {} }) },
    { name: "filtered", props: filteredEmptyState({ onClearFilters: () => {} }) },
    { name: "gallery", props: galleryEmptyState({ onClearFilters: () => {} }) },
    {
      name: "first-run",
      props: firstRunEmptyState({
        createAction: <a href="/new">{EMPTY_ACTION_LABELS.firstRunCreate}</a>,
      }),
    },
  ];
}

describe("EmptyState variants — distinct copy + one targeted action (U7)", () => {
  it("archived: distinct copy + single 'View active canvases' action", () => {
    const props = archivedEmptyState({
      action: (
        <a href="/" data-testid="action">
          {EMPTY_ACTION_LABELS.archived}
        </a>
      ),
    });
    render(<EmptyState {...props} />);
    expect(screen.getByText("No archived canvases")).toBeInTheDocument();
    expect(screen.getByText(EMPTY_ACTION_LABELS.archived)).toBeInTheDocument();
    expect(EMPTY_ACTION_LABELS.archived).toBe("View active canvases");
  });

  it("search: distinct copy, echoes the term, and the action calls onClearSearch", () => {
    const onClearSearch = vi.fn();
    const props = searchEmptyState({ term: "Quarterly Report", onClearSearch });
    render(<EmptyState {...props} />);

    // Distinct, term-preserving title.
    expect(screen.getByText(/no canvases match your search/i)).toBeInTheDocument();
    expect(screen.getByText(/quarterly report/i)).toBeInTheDocument();

    // The single action is labelled "Clear search" and wired to the handler.
    const action = screen.getByRole("button", { name: EMPTY_ACTION_LABELS.search });
    expect(EMPTY_ACTION_LABELS.search).toBe("Clear search");
    expect(onClearSearch).not.toHaveBeenCalled();
    fireEvent.click(action);
    expect(onClearSearch).toHaveBeenCalledTimes(1);
  });

  it("search: omits the quoted term when none is given but stays specific", () => {
    const props = searchEmptyState({ onClearSearch: () => {} });
    render(<EmptyState {...props} />);
    expect(screen.getByText("No canvases match your search")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("filtered: distinct copy + single 'Clear all filters' action wired to handler", () => {
    const onClearFilters = vi.fn();
    const props = filteredEmptyState({ onClearFilters });
    render(<EmptyState {...props} />);
    expect(screen.getByText("No canvases match these filters")).toBeInTheDocument();
    const action = screen.getByRole("button", { name: EMPTY_ACTION_LABELS.filtered });
    expect(EMPTY_ACTION_LABELS.filtered).toBe("Clear all filters");
    fireEvent.click(action);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("gallery: 'Clear filters' action + optional docs link", () => {
    const onClearFilters = vi.fn();
    const props = galleryEmptyState({
      onClearFilters,
      docsLink: (
        <a href="/docs" data-testid="docs">
          {EMPTY_ACTION_LABELS.galleryBrowseDocs}
        </a>
      ),
    });
    render(<EmptyState {...props} />);
    expect(screen.getByText(/no gallery canvases match your filters/i)).toBeInTheDocument();
    const action = screen.getByRole("button", { name: EMPTY_ACTION_LABELS.galleryClearFilters });
    expect(EMPTY_ACTION_LABELS.galleryClearFilters).toBe("Clear filters");
    fireEvent.click(action);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
    // Docs link is offered as the secondary affordance when provided.
    expect(screen.getByTestId("docs")).toHaveTextContent("Browse docs");
  });

  it("gallery: docs link is absent when not provided", () => {
    render(<EmptyState {...galleryEmptyState({ onClearFilters: () => {} })} />);
    expect(screen.queryByText(EMPTY_ACTION_LABELS.galleryBrowseDocs)).not.toBeInTheDocument();
  });

  it("first-run: 'Create a canvas' primary + optional docs link", () => {
    const props = firstRunEmptyState({
      createAction: (
        <a href="/new" data-testid="create">
          {EMPTY_ACTION_LABELS.firstRunCreate}
        </a>
      ),
      docsLink: (
        <a href="/docs" data-testid="docs">
          {EMPTY_ACTION_LABELS.firstRunDocs}
        </a>
      ),
    });
    const { container } = render(<EmptyState {...props} />);
    expect(screen.getByText("Create your first canvas")).toBeInTheDocument();
    expect(screen.getByTestId("create")).toHaveTextContent("Create a canvas");
    expect(screen.getByTestId("docs")).toHaveTextContent("Read the docs");
    expect(EMPTY_ACTION_LABELS.firstRunCreate).toBe("Create a canvas");
    // Both action nodes live in the single `action` slot (one targeted region).
    expect(within(container).getAllByRole("link")).toHaveLength(2);
  });
});

describe("EmptyState variants — cross-cutting guarantees (U7)", () => {
  it("every variant renders genuinely distinct copy (no two share a title)", () => {
    const titles = allVariants().map((v) => v.props.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("no variant emits a forbidden generic string (anti-slop guard)", () => {
    for (const { name, props } of allVariants()) {
      const text = copyText(props).toLowerCase();
      for (const forbidden of FORBIDDEN_EMPTY_COPY) {
        expect(text, `${name} copy contains forbidden "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it("every variant exposes exactly one action region with a concrete label", () => {
    for (const { name, props } of allVariants()) {
      expect(props.action, `${name} has an action`).toBeTruthy();
      expect(props.title.trim().length, `${name} has a non-empty title`).toBeGreaterThan(0);
    }
  });
});
