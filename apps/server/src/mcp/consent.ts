import { createHmac, timingSafeEqual } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { escapeAttribute, escapeHtml } from "../http/error-pages.js";

/**
 * MCP authorization consent (§12.0 #1, #3). A signed-in member delegates their
 * account to an agent only after approving that specific client on a same-origin
 * page. The approval travels back to `/authorize` as a short-lived token bound to
 * the user, client, redirect URI and PKCE challenge, so it can't be replayed for a
 * different client or a different authorization request.
 */

/** How long an approval stays usable between the consent POST and `/authorize`. */
const CONSENT_TTL_MS = 10 * 60 * 1000;

/** The query parameter carrying an approval back to `/authorize`. */
export const CONSENT_PARAM = "consent";

export interface ConsentBinding {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

function mac(secret: string, b: ConsentBinding, exp: number): string {
  return createHmac("sha256", secret)
    .update(
      ["mcp-consent:v1", b.userId, b.clientId, b.redirectUri, b.codeChallenge, exp].join("\0"),
    )
    .digest("hex");
}

export function signConsent(secret: string, b: ConsentBinding, now = Date.now()): string {
  const exp = now + CONSENT_TTL_MS;
  return `${exp}.${mac(secret, b, exp)}`;
}

export function verifyConsent(
  secret: string,
  b: ConsentBinding,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = Buffer.from(`${exp}.${mac(secret, b, exp)}`);
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The authorization request fields the consent form carries back unchanged. */
const CARRIED_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
] as const;

export function carriedParams(source: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of CARRIED_PARAMS) {
    const value = source.get(key);
    if (value !== null) out.set(key, value);
  }
  return out;
}

/** Headers for the consent page: never framed, never cached. */
export const CONSENT_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "frame-ancestors 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
};

export function renderConsentPage(input: {
  client: OAuthClientInformationFull;
  redirectUri: string;
  accountEmail: string;
  params: URLSearchParams;
}): string {
  const name = input.client.client_name?.trim() || "An unnamed app";
  let destination = input.redirectUri;
  try {
    destination = new URL(input.redirectUri).host || input.redirectUri;
  } catch {
    // Keep the raw value; the router already validated it against the registration.
  }
  const hidden = [...input.params]
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeAttribute(k)}" value="${escapeAttribute(v)}">`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access to canvas-drop?</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f4;color:#1c1c1a}
main{max-width:26rem;padding:2rem;background:#fff;border:1px solid #e3e3df;border-radius:12px}
h1{font-size:1.15rem;margin:0 0 .75rem}
p{margin:.5rem 0;color:#4a4a46}
.row{display:flex;gap:.5rem;margin-top:1.5rem}
button{font:inherit;padding:.5rem 1rem;border-radius:8px;border:1px solid #c9c9c3;background:#fff;cursor:pointer}
button[value=allow]{background:#1c1c1a;color:#fff;border-color:#1c1c1a}
</style>
</head>
<body>
<main>
<h1>Allow ${escapeHtml(name)} to use your canvas-drop account?</h1>
<p>It will act as <strong>${escapeHtml(input.accountEmail)}</strong> and can do anything you can do in canvas-drop, including reading and changing your canvases.</p>
<p>After you allow it, you'll be sent to <strong>${escapeHtml(destination)}</strong>.</p>
<p>Only continue if you started connecting this app yourself.</p>
<form method="post" action="/authorize/consent">${hidden}
<div class="row"><button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Cancel</button></div>
</form>
</main>
</body>
</html>`;
}
