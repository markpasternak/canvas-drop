/**
 * Account avatar hue — the dashboard's copy of `accountAvatarHue` in
 * packages/shared/src/brand/avatar.ts (the dashboard bundle doesn't import the shared
 * package). Both sides pin the same test vectors, so the same account gets the same
 * colour in the account menu, the account chooser and the wrong-account page. The
 * colours themselves are the `.account-avatar` rules in styles/base.css.
 */
const HUES = [190, 30, 145, 290, 75, 345, 240, 110] as const;

export function accountAvatarHue(email: string): number {
  let hash = 0x811c9dc5;
  for (const ch of email.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return HUES[(hash >>> 0) % HUES.length] ?? 190;
}

/** Session-storage key the switch form leaves for the next page load's notice. */
export const SWITCHED_TO_KEY = "canvas-drop:switched-to";
