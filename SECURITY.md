# Security Policy

canvas-drop is a self-hostable platform whose security rests on a small set of
**hard invariants** (BUILD_BRIEF §12.0). We take reports against those invariants
seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's **[Report a vulnerability](https://github.com/markpasternak/canvas-drop/security/advisories/new)**
(Security → Advisories → Report a vulnerability). If you cannot use that, contact
the repository owner.

Include, where you can:

- The component and version / commit.
- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept is ideal).
- Any deployment configuration relevant to the finding (auth mode, URL mode, etc.).

**Response expectations:** this is an open-source project maintained on a
best-effort basis. We aim to acknowledge a report within a few days, agree on a
disclosure timeline with you, and credit you in the advisory unless you prefer
otherwise.

## What's in scope

The security-critical surface is the five hard invariants (see the
[Security model](docs/site/self-hosting/security-model.md) and BUILD_BRIEF §12.0):

1. **Authentication** — identity always comes from the server-side auth context,
   never the client. In `proxy` mode only the trusted proxy may assert identity.
2. **Authorization** — a canvas is reachable only by principals its access rung
   allows; revoke/expiry/password are honored, including **live** on open
   realtime sockets.
3. **Canvas isolation** — in `subdomain` mode, no cross-canvas access over HTTP
   **and** WebSocket. Path mode has reduced browser isolation and is for
   local/trusted own-hosting unless the operator opts into the tradeoff.
4. **Secret handling** — AI provider keys and canvas API keys are server-side
   only and never reach the browser; keys are stored hashed.
5. **Upload safety** — the deploy pipeline rejects zip-slip and serves
   server-side executables as inert text.

Findings that bypass any of these are high priority. Reports against
non-invariant surfaces are welcome too and triaged proportionately —
canvas-drop's threat model is a **trusted organization**, not the hostile public
internet (see the security model doc).

## Supported versions

canvas-drop is pre-1.0; security fixes land on `main`. Pin to a commit you have
reviewed and update deliberately.
