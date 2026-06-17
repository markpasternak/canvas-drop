import { describe, expect, it } from "vitest";
import { cosmeticSlug, slugPreviewUrl } from "../lib/cosmetic-slug.js";

describe("cosmeticSlug", () => {
  it("lowercases, hyphenates, and trims", () => {
    expect(cosmeticSlug("My App")).toBe("my-app");
    expect(cosmeticSlug("  Hello__World!!  ")).toBe("hello-world");
    expect(cosmeticSlug("-edge-")).toBe("edge");
    expect(cosmeticSlug("✨")).toBe("");
  });
});

describe("slugPreviewUrl", () => {
  it("builds a path-mode URL", () => {
    expect(slugPreviewUrl("my-app", { urlMode: "path", baseUrl: "https://drop.example.com" })).toBe(
      "https://drop.example.com/c/my-app/",
    );
  });

  it("builds a subdomain-mode URL from the base host", () => {
    expect(
      slugPreviewUrl("my-app", { urlMode: "subdomain", baseUrl: "https://drop.example.com" }),
    ).toBe("https://my-app.drop.example.com/");
  });

  it("tolerates a trailing slash on baseUrl", () => {
    expect(slugPreviewUrl("x", { urlMode: "path", baseUrl: "https://h/" })).toBe("https://h/c/x/");
  });

  it("falls back to string concatenation when baseUrl is not parseable (subdomain)", () => {
    expect(slugPreviewUrl("x", { urlMode: "subdomain", baseUrl: "not a url" })).toBe("x.not a url");
  });
});
