import { describe, expect, it } from "vitest";
import {
  ACCOUNT_AVATAR_HUES,
  ACCOUNT_AVATAR_TONES,
  accountAvatarColor,
  accountAvatarCss,
  accountAvatarHue,
} from "./avatar.js";
import { AA_TEXT, contrastRatio } from "./contrast.js";

describe("account avatar colours", () => {
  it("gives the same account the same hue, whatever the email's case or padding", () => {
    expect(accountAvatarHue("Mark@Work.example ")).toBe(accountAvatarHue("mark@work.example"));
    expect(ACCOUNT_AVATAR_HUES).toContain(accountAvatarHue("anyone@example.com"));
  });

  it("matches the dashboard's copy (apps/dashboard/src/lib/account-avatar.ts) on pinned vectors", () => {
    // The same vectors are pinned in the dashboard's account-avatar test.
    expect(accountAvatarHue("mark@personal.example")).toBe(75);
    expect(accountAvatarHue("mark@work.example")).toBe(345);
    expect(accountAvatarHue("mp@client.example")).toBe(290);
    expect(accountAvatarHue("bob@other.example")).toBe(240);
  });

  it("spreads different accounts across more than one hue", () => {
    const hues = new Set(
      ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io", "f@x.io"].map(accountAvatarHue),
    );
    expect(hues.size).toBeGreaterThan(2);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`keeps the initial readable (AA) on every hue in ${theme}`, () => {
      const { bg, fg } = ACCOUNT_AVATAR_TONES[theme];
      for (const hue of ACCOUNT_AVATAR_HUES) {
        const ratio = contrastRatio(accountAvatarColor(fg, hue), accountAvatarColor(bg, hue));
        expect(ratio, `hue ${hue}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });
  }

  it("emits light and both dark-theme rules for server pages", () => {
    const css = accountAvatarCss(".avatar");
    expect(css).toContain(".avatar { background: oklch(0.92 0.05 var(--avatar-hue, 190))");
    expect(css).toContain(':root:not([data-theme="light"]) .avatar');
    expect(css).toContain(':root[data-theme="dark"] .avatar');
  });
});
