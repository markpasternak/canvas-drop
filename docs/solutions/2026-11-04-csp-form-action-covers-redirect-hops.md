# CSP `form-action` covers every redirect hop of a form submission

**Symptom.** Adding the canvas-drop MCP from Claude (business connector flow) failed on
the consent page in Chrome: `Sending form data to 'https://<host>/authorize/consent'
violates the following Content Security Policy directive: "form-action 'self'"`.
The named URL is same-origin, which makes the message look impossible.

**Cause.** CSP3 applies `form-action` to the whole navigation a form starts, including
redirects. Allow goes `POST /authorize/consent` → 303 `/authorize?…&consent=…` → 302 to
the client's `redirect_uri` (claude.ai); Cancel goes 303 straight there. The final,
cross-origin hop is what gets blocked, and Chrome reports the *pre-redirect* URL so it
doesn't leak where the redirect went. Members who already held a live grant never saw
the consent page (plain GET redirect, no form), so only first-time connections broke.

**Fix.** `consentHeaders(redirectUri)` in `apps/server/src/mcp/consent.ts` adds the
validated redirect URI's origin (or scheme, for custom-scheme apps) to `form-action`,
per request. The value is checked to be a single CSP token so it can't add directives.

**Rule of thumb.** Any page whose form POST ends in a redirect to another origin needs
that origin in `form-action`, even when the form's `action` is same-origin. A quick
Playwright check (form → 303 → 302 cross-origin) reproduces it in headless Chromium;
`app.request` tests can't, since they don't enforce CSP.
