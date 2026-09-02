import { describe, expect, it, vi } from "vitest";
import {
  applyCreateAudience,
  defaultCreateAudience,
  initialAudiencePatch,
  resetAudienceForDestination,
} from "../lib/create-audience.js";

describe("create audience", () => {
  it("maps workspace access to link-only or listed discoverability", () => {
    expect(
      initialAudiencePatch({
        ...defaultCreateAudience(),
        choice: "workspace",
        listed: false,
      }),
    ).toEqual({ access: "whole_org", discoverability: "link_only" });
    expect(
      initialAudiencePatch({
        ...defaultCreateAudience(),
        choice: "workspace",
        listed: true,
      }),
    ).toEqual({ access: "whole_org", discoverability: "listed" });
  });

  it("submits a public password only when its modifier is enabled", () => {
    expect(
      initialAudiencePatch({
        choice: "public",
        listed: false,
        requirePassword: false,
        password: "stale secret",
      }),
    ).toEqual({ access: "public_link", discoverability: "link_only" });
    expect(
      initialAudiencePatch({
        choice: "public",
        listed: false,
        requirePassword: true,
        password: "  launch-code  ",
      }),
    ).toEqual({
      access: "public_link",
      discoverability: "link_only",
      password: "launch-code",
    });
  });

  it("keeps private creation free of a settings patch", () => {
    expect(initialAudiencePatch(defaultCreateAudience())).toBeNull();
  });

  it("resets wider choices whenever the destination changes", () => {
    expect(
      resetAudienceForDestination({
        choice: "workspace",
        listed: true,
        requirePassword: false,
        password: "",
      }),
    ).toEqual(defaultCreateAudience());
    expect(
      resetAudienceForDestination({
        choice: "public",
        listed: false,
        requirePassword: true,
        password: "secret",
      }),
    ).toEqual(defaultCreateAudience());
  });

  it("applies wider access and reports a fail-closed Restricted fallback", async () => {
    const update = vi.fn().mockResolvedValue({});
    await expect(
      applyCreateAudience("c1", { ...defaultCreateAudience(), choice: "workspace" }, update),
    ).resolves.toEqual({ kind: "applied" });
    expect(update).toHaveBeenCalledWith("c1", {
      access: "whole_org",
      discoverability: "link_only",
    });

    const error = new Error("sharing unavailable");
    await expect(
      applyCreateAudience(
        "c1",
        { ...defaultCreateAudience(), choice: "public" },
        vi.fn().mockRejectedValue(error),
      ),
    ).resolves.toEqual({ kind: "failed", error });
  });
});
