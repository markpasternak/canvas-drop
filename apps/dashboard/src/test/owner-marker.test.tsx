import { describe, expect, it } from "vitest";
import { ownerBadge, ownerMarker } from "../components/CanvasList.js";

/** The "owned by <name> · editor" marker on edited rows (editor-roles plan U9, R15). */
describe("ownerMarker", () => {
  it("is null for the viewer's own canvases and for rows without a role", () => {
    expect(
      ownerMarker({ role: "owner", owner: { id: "o", name: "Olive", email: "o@e.com" } }),
    ).toBeNull();
    expect(ownerMarker({ role: null, owner: null })).toBeNull();
    expect(ownerMarker({ owner: null })).toBeNull();
  });

  it("names the owner by display name, falling back to email, then a neutral label", () => {
    expect(
      ownerMarker({ role: "editor", owner: { id: "o", name: "Olive Owner", email: "o@e.com" } }),
    ).toBe("owned by Olive Owner · editor");
    expect(ownerMarker({ role: "editor", owner: { id: "o", name: "  ", email: "o@e.com" } })).toBe(
      "owned by o@e.com · editor",
    );
    expect(ownerMarker({ role: "editor", owner: null })).toBe("owned by someone else · editor");
  });

  it("has a compact card form: the role first, then the owner's name", () => {
    expect(ownerBadge({ role: "editor", owner: { id: "u", name: "Ada", email: "a@x" } })).toBe(
      "editor · Ada",
    );
    expect(ownerBadge({ role: "owner", owner: null })).toBeNull();
  });
});
