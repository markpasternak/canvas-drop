/**
 * Email-domain normalization for tenancy membership (plan 002, KTD2).
 *
 * Membership is an EXACT match of a user's verified email domain against an org's
 * configured domains, so both sides must normalize identically: trim, lowercase,
 * strip one trailing FQDN dot, and require the ASCII letters-digits-hyphen set with
 * at least one label-dot. Non-ASCII (IDN) domains must be punycode-encoded by the
 * operator first — we do NOT silently transform them, because this is an authorization
 * boundary and a silent transform could merge or split a membership set.
 */

// One-or-more LDH labels separated by dots, each label starting/ending alphanumeric.
// Requires a dot (a real domain has a TLD) — bare hostnames like `localhost` are not
// membership domains.
const LDH_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Normalize a domain, or throw — for fail-loud config/boot validation. */
export function normalizeDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/\.$/, "");
  if (!LDH_DOMAIN.test(d)) {
    throw new Error(
      `invalid email domain "${input}": expected an ASCII domain like "acme.com" (punycode IDNs first)`,
    );
  }
  return d;
}

/**
 * Normalize a domain, or return null when malformed — for runtime user-domain
 * resolution, where an odd email must yield "no org" (a guest), never an exception.
 */
export function tryNormalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    return normalizeDomain(input);
  } catch {
    return null;
  }
}

/** Extract + normalize the domain part of an email; null when there's no usable domain. */
export function domainOfEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return tryNormalizeDomain(email.slice(at + 1));
}

/** Deterministic URL-safe slug for an org name (the orgs.slug unique key). */
export function orgSlug(name: string): string {
  // Split on runs of non-alphanumerics and rejoin with single dashes. This collapses
  // separators and drops leading/trailing ones in a single linear pass — unlike a
  // trailing-dash trim (`/-+$/`), it has no polynomial backtracking on pathological
  // input (ReDoS-safe). Input is operator config (CANVAS_DROP_ORG_NAME) at boot, but
  // the linear form keeps the regex honest regardless.
  const s = name
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
  return s || "org";
}
