import { describe, expect, it } from "vitest";
import {
  configuredLinkPreview,
  isLinkPreviewDefault,
  linkPreviewChoice,
  linkPreviewLevel,
  linkPreviewModeOf,
} from "./link-preview.js";

const live = {
  linkPreviewMode: null as string | null,
  access: "whole_org",
  status: "active",
  currentVersionId: "v",
  sharedExpiresAt: null as number | null,
};

describe("link preview resolution", () => {
  it("maps the API choice to and from the stored mode", () => {
    expect(linkPreviewModeOf(true)).toBe("on");
    expect(linkPreviewModeOf(false)).toBe("off");
    expect(linkPreviewModeOf(null)).toBeNull();
    expect(linkPreviewChoice({ linkPreviewMode: "on" })).toBe(true);
    expect(linkPreviewChoice({ linkPreviewMode: "off" })).toBe(false);
    expect(linkPreviewChoice({ linkPreviewMode: null })).toBeNull();
    // An unknown stored value reads as "follow the default", never as on.
    expect(linkPreviewChoice({ linkPreviewMode: "maybe" })).toBeNull();
  });

  it("a per-canvas choice wins over the instance default", () => {
    expect(configuredLinkPreview({ ...live, linkPreviewMode: "on" }, "off")).toBe("cover");
    expect(configuredLinkPreview({ ...live, linkPreviewMode: "off" }, "cover")).toBe("none");
  });

  it("the instance default applies to whole-org canvases only", () => {
    expect(configuredLinkPreview(live, "title")).toBe("title");
    expect(configuredLinkPreview(live, "cover")).toBe("cover");
    expect(configuredLinkPreview(live, "off")).toBe("none");
    for (const access of ["private", "specific_people", "team", "public_link"]) {
      expect(configuredLinkPreview({ ...live, access }, "cover"), access).toBe("none");
    }
    // An explicit on still works on a restricted canvas.
    expect(
      configuredLinkPreview({ ...live, access: "private", linkPreviewMode: "on" }, "off"),
    ).toBe("cover");
  });

  it("only a live, published, unexpired canvas unfurls", () => {
    expect(linkPreviewLevel(live, "title", 10)).toBe("title");
    expect(linkPreviewLevel({ ...live, status: "disabled" }, "title", 10)).toBe("none");
    expect(linkPreviewLevel({ ...live, currentVersionId: null }, "title", 10)).toBe("none");
    expect(linkPreviewLevel({ ...live, sharedExpiresAt: 10 }, "title", 10)).toBe("none");
    expect(linkPreviewLevel({ ...live, sharedExpiresAt: 11 }, "title", 10)).toBe("title");
  });

  it("validates admin default values", () => {
    expect(isLinkPreviewDefault("cover")).toBe(true);
    expect(isLinkPreviewDefault("all")).toBe(false);
    expect(isLinkPreviewDefault(undefined)).toBe(false);
  });
});
