import type { Config } from "@canvas-drop/shared";

/**
 * Post-login redirect ("returnTo") plumbing for `oidc` mode.
 *
 * A signed-out visitor who opens a shared canvas link is bounced to `/auth/login`
 * → the IdP → `/auth/callback`. Without carrying where they were headed, they land
 * on `/` (the welcome page) after signing in — never the canvas they clicked. We
 * thread the original URL through the login flow and validate it on the way out so
 * it can't be turned into an open redirect.
 *
 * In `subdomain` mode the canvas lives on `<slug>.{host}` but the callback runs on
 * the apex (the `redirect_uri` is built from `baseUrl`), so the returnTo MUST be an
 * absolute URL carrying the canvas subdomain — a relative path would resolve
 * against the apex and lose the subdomain.
 */

/**
 * The instance's public origin for THIS request: the scheme from `baseUrl` plus
 * the forwarded `Host`. Behind a TLS-terminating proxy (Caddy) the inbound request
 * is plain `http` on an internal host, so we can't trust the request's own scheme;
 * but the proxy forwards the public Host (that's how subdomain routing resolves).
 * Falls back to the configured host when no Host header is present.
 */
export function publicOrigin(config: Config, host: string | undefined | null): string {
  const scheme = config.baseUrl.startsWith("https") ? "https" : "http";
  const resolvedHost = host && host.length > 0 ? host : new URL(config.baseUrl).host;
  return `${scheme}://${resolvedHost}`;
}

/**
 * Validate a candidate post-login redirect against open-redirect abuse. Returns a
 * safe destination — a same-site relative path, or an absolute URL on this instance
 * or one of its canvas subdomains — or `undefined` to fall back to the default.
 *
 * Rejected: protocol-relative (`//evil`, `/\evil`) and backslash tricks, off-host
 * absolute URLs, scheme downgrades/upgrades, and any `/auth/*` target (which would
 * just bounce the user back into the login dance).
 */
export function safeReturnTo(config: Config, raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;

  let result: string;
  let pathname: string;

  if (raw.startsWith("/")) {
    // Relative path. Reject protocol-relative forms the browser would treat as
    // off-site (`//host`, and the `/\` / `/%2f` backslash/encoded variants). The
    // encoded check is case-insensitive (`%2F` and `%2f` are equivalent).
    const head = raw.slice(0, 4).toLowerCase();
    if (raw.startsWith("//") || raw.startsWith("/\\") || head.startsWith("/%2f")) {
      return undefined;
    }
    result = raw;
    try {
      pathname = new URL(raw, config.baseUrl).pathname;
    } catch {
      return undefined;
    }
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    const base = new URL(config.baseUrl);
    if (url.protocol !== base.protocol) return undefined;
    const host = url.host.toLowerCase();
    const baseHost = base.host.toLowerCase();
    if (host !== baseHost && !host.endsWith(`.${baseHost}`)) return undefined;
    result = url.href;
    pathname = url.pathname;
  }

  // Never return to the auth surface itself — that just re-triggers login.
  if (pathname === "/auth" || pathname.startsWith("/auth/")) return undefined;

  return result;
}

/**
 * Build the `/auth/login` URL, carrying a validated `returnTo` when present. The
 * value is validated here so callers can pass raw, untrusted input.
 */
export function loginUrl(config: Config, returnTo?: string | null): string {
  const safe = safeReturnTo(config, returnTo ?? undefined);
  return safe ? `/auth/login?returnTo=${encodeURIComponent(safe)}` : "/auth/login";
}

/**
 * The public URL of the current request (origin + path + query), suitable as a
 * returnTo. Rebuilt from the forwarded Host so it survives the proxy hop.
 */
export function requestReturnTo(
  config: Config,
  host: string | undefined | null,
  url: string,
): string {
  const reqUrl = new URL(url);
  return `${publicOrigin(config, host)}${reqUrl.pathname}${reqUrl.search}`;
}
