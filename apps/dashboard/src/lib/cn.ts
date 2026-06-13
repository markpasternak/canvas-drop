/** Join conditional class names (falsy entries dropped). Small by design — we
 * don't need tailwind-merge for our component surface. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
