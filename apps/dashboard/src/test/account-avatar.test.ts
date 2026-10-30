import { describe, expect, it } from "vitest";
import { accountAvatarHue } from "../lib/account-avatar.js";

describe("accountAvatarHue (dashboard copy)", () => {
  it("matches the shared server-page hue on pinned vectors", () => {
    // Pinned identically in packages/shared/src/brand/avatar.test.ts.
    expect(accountAvatarHue("mark@personal.example")).toBe(75);
    expect(accountAvatarHue("mark@work.example")).toBe(345);
    expect(accountAvatarHue("mp@client.example")).toBe(290);
    expect(accountAvatarHue("bob@other.example")).toBe(240);
    expect(accountAvatarHue(" Bob@Other.Example")).toBe(240);
  });
});
