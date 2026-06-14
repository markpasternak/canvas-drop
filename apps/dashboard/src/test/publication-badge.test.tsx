import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GalleryBadge, PublicationBadge, VisibilityBadge } from "../components/Badge.js";
import type { PublicationState } from "../lib/api.js";

describe("PublicationBadge", () => {
  it.each([
    ["draft", "Draft"],
    ["published", "Published"],
    ["archived", "Archived"],
    ["disabled", "Disabled"],
  ] as [PublicationState, string][])("renders %s as %s", (state, label) => {
    render(<PublicationBadge state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("VisibilityBadge", () => {
  it("renders Shared vs Private", () => {
    const { rerender } = render(<VisibilityBadge shared={true} />);
    expect(screen.getByText("Shared")).toBeInTheDocument();
    rerender(<VisibilityBadge shared={false} />);
    expect(screen.getByText("Private")).toBeInTheDocument();
  });
});

describe("GalleryBadge", () => {
  it("renders Template > Listed > Unlisted by precedence", () => {
    const { rerender } = render(
      <GalleryBadge canvas={{ galleryListed: true, galleryTemplatable: true }} />,
    );
    expect(screen.getByText("Template")).toBeInTheDocument();
    rerender(<GalleryBadge canvas={{ galleryListed: true, galleryTemplatable: false }} />);
    expect(screen.getByText("Listed")).toBeInTheDocument();
    rerender(<GalleryBadge canvas={{ galleryListed: false, galleryTemplatable: false }} />);
    expect(screen.getByText("Unlisted")).toBeInTheDocument();
  });
});
