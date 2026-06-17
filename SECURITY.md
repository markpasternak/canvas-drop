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

1. **No impersonation** — identity always comes from the server-side auth
   context, never the client. In `proxy` mode only the trusted proxy may assert
   identity.
2. **No credential or canvas theft** — no user can read or steal another user's
   session, canvas API key, or canvas content; keys and tokens are hashed at
   rest and shown once.
3. **No unauthorized access** — a canvas is reachable only by principals its
   access rung allows; revoke/expiry/password are honored, including **live** on
   open realtime sockets.
4. **No cross-canvas reach in subdomain mode** — one canvas (or its code, SDK,
   or socket) cannot read, write, or act on another canvas's data, files, AI
   quota, or realtime channels. Path mode has reduced browser isolation and is
   for local/trusted own-hosting unless the operator opts into the tradeoff.
5. **Lifecycle is honored instantly** — revoke, expiry, disable, delete, slug
   regen, key regen, rung lowering, and unpublish take effect on the next
   request and drop live realtime sockets.

The deploy pipeline's upload safety (rejecting zip-slip and serving server-side
executables as inert text) is a §12.1 input-hardening control that is also in
scope, alongside the five hard invariants above.

Findings that bypass any of these are high priority. Reports against
non-invariant surfaces are welcome too and triaged proportionately —
canvas-drop's threat model is a **trusted organization**, not the hostile public
internet (see the security model doc).

## Supported versions

canvas-drop is pre-1.0; security fixes land on `main`. Pin to a commit you have
reviewed and update deliberately.
