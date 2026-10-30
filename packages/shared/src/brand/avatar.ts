/**
 * Account avatar colours (multi-account switcher).
 *
 * When the identity provider gives no photo, an account shows its initial on a tinted
 * disc. With several accounts on one browser, a single brand tint makes every row look
 * the same ("M", "M", "M"), so each account gets one of a few hues, picked from its
 * email so the same account looks the same everywhere: the dashboard menu, the account
 * chooser and the wrong-account page.
 *
 * Surfaces set `--avatar-hue` on the disc and use {@link accountAvatarCss} (server
 * pages) or the matching `.account-avatar` rules in the dashboard's base.css. The
 * lightness/chroma pairs below clear WCAG AA for the initial in both themes for every
 * hue (avatar.test.ts).
 */

/** OKLCH hues, spaced so neighbours are easy to tell apart. The brand teal is first. */
export const ACCOUNT_AVATAR_HUES = [190, 30, 145, 290, 75, 345, 240, 110] as const;

/** Lightness/chroma of the disc and the initial, per theme (hue comes from the account). */
export const ACCOUNT_AVATAR_TONES = {
  light: { bg: { l: 0.92, c: 0.05 }, fg: { l: 0.42, c: 0.1 } },
  dark: { bg: { l: 0.34, c: 0.06 }, fg: { l: 0.88, c: 0.07 } },
} as const;

/** The hue for an account, stable for its (case-insensitive) email. */
export function accountAvatarHue(email: string): number {
  // FNV-1a: tiny, dependency-free and evenly spread for short strings.
  let hash = 0x811c9dc5;
  for (const ch of email.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return ACCOUNT_AVATAR_HUES[(hash >>> 0) % ACCOUNT_AVATAR_HUES.length] ?? 190;
}

/** The OKLCH colour for one tone at a given hue. */
export function accountAvatarColor(tone: { l: number; c: number }, hue: number | string): string {
  return `oklch(${tone.l} ${tone.c} ${hue})`;
}

/**
 * CSS for `selector` discs on server-rendered pages, following the page's theme the same
 * way the system pages do (OS preference unless `data-theme` pins one).
 */
export function accountAvatarCss(selector: string): string {
  const { light, dark } = ACCOUNT_AVATAR_TONES;
  const rule = (t: typeof light | typeof dark) =>
    `background: ${accountAvatarColor(t.bg, "var(--avatar-hue, 190)")}; color: ${accountAvatarColor(t.fg, "var(--avatar-hue, 190)")};`;
  return `  ${selector} { ${rule(light)} }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) ${selector} { ${rule(dark)} } }
  :root[data-theme="dark"] ${selector} { ${rule(dark)} }`;
}
