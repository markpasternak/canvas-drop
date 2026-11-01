# Product marketing context

**Document version:** v1

**Last updated:** 2026-11-01

This context is derived from the repository for the landing-page copy refresh.
Product behavior below is source-backed. Audience motivations and positioning
are working interpretations, not customer research or measured results.

## Product overview

Canvas Drop is an MIT-licensed, self-hosted place to publish and share canvases:
small web tools made from HTML, CSS, JavaScript and assets. Bring files from an AI
chat, cloud workspace or local editor, then give people a stable URL. Members can
edit drafts, publish versions, manage access and recover earlier published files.

The category is internal web-tool publishing and sharing. It is an open-source
project operated on the user's infrastructure; this repository establishes no
hosted service, paid plan or commercial pricing.

Sources: `PRODUCT.md`, `README.md`, `BUILD_BRIEF.md` §§1, 3–4;
`docs/site/authoring/create-and-publish.md`.

## Audience and jobs

The documented audience is technical-to-semi-technical internal builders:
developers, designers and colleagues making useful browser tools, often with AI.
First-run self-hosters and organization admins also evaluate and operate it.

- Builders need to publish a working artifact and keep improving the same link.
- Colleagues need to open tools shared with them and contribute within their role.
- Operators need to use existing sign-in, manage access and run their own instance.

Examples include interactive reports, calculators, planning tools, prototypes and
small internal apps. Industry, company size, purchasing roles and budgets are not
validated audience segments. Spec personas describe intended users, not interviews.

## Problem and switching context

The repository's product thesis is that generating a web interface with AI is
easier than making it available to colleagues with appropriate access. It names
ZIPs in chat, inaccessible workspaces and one-off deployment requests as the
workarounds. Stable links, explicit sharing and version recovery answer that gap.

Likely adoption concerns include running an instance, trusting generated code,
configuring sign-in and understanding the limits of static hosting. These are
inferred concerns, not reported sales objections. No quantified time or cost
savings, conversion data or customer sentiments are available here.

## Positioning and differentiation

Lead with **make a tool with AI, then share it as a canvas**. Explain immediately
that tools can also come from a cloud workspace or local files. Canvas Drop is
the publishing and sharing product; the reader's chosen tools or agent make the
web code. The optional AI backend is a separate capability inside a canvas.

Highlight this combination, in order:

1. An MCP-compatible agent can create and publish canvases, edit drafts and manage
   sharing as the signed-in account, with the dashboard's role checks.
2. Published updates keep the canvas URL. Draft editing leaves the published
   version available; earlier published files can be restored or made current.
3. Organization sign-in and named people/teams with viewer or editor roles.
   General access can widen to the organization or an admin-allowed public link.
4. Optional fixed backend features: data storage, files, AI, identity, realtime
   and admin-granted Connections. Authoring is separately gated.
5. MIT source and self-hosting with configurable authentication, database and
   file storage. Canvas Drop does not phone home or load third-party tracking.

Sources: `docs/site/agents/mcp.md`, `apps/server/src/mcp/tool-roles.ts`,
`docs/site/authoring/create-and-publish.md`, `docs/site/authoring/sharing.md`,
`docs/site/sdk/overview.md`, `docs/site/sdk/authoring.md`, `README.md`.

These are product strengths, not proof that named competitors lack them. The repo
mentions Shopify Quick as inspiration and general app hosts as a different fit.
No current competitor comparison, win/loss evidence or market-leadership claim is
established. Avoid “best,” “fastest,” “most secure” and invented superiority.

## Fit and constraints

Canvases serve static files, including built frontend output. Canvas Drop does
not run a canvas's custom server code or frontend build. Backend access depends
on permissions and configuration; AI needs a configured provider, Connections
need an admin grant, and authoring must be enabled separately. Do not imply public
links grant anonymous access to every backend feature. Guest AI has its own policy.

Recommended multi-user deployment uses HTTPS and separate canvas subdomains.
Version recovery restores published files; live backend data has a separate
lifecycle. Configured AI providers and Connections can send data to chosen
external services, so avoid an absolute “all data stays inside” claim.

## Language and voice

Follow `PRODUCT.md`: precise, trustworthy and unobtrusive. Use plain English,
concrete actions and correct product terms. Say **canvas** throughout; explain it
once as a small web tool. Use “publish,” “draft,” “viewer,” “editor,” “people and
teams,” “organization sign-in,” “stable URL” and “MCP” with context.

The owner's direction for this refresh was to focus on the product's strengths
and “use the word canvas.” This is stakeholder direction, not customer testimony.
No customer quotations are recorded. Avoid generic AI slogans, unearned security
promises, invented labels, contrast reveals and superlatives. Do not name a
specific AI assistant as the only supported authoring workflow.

## Proof and conversion goals

Use real product screenshots with example content, documented workflows, the
source repository and the MIT license as evidence. There are no verified customer
logos, adoption numbers, testimonials or performance benchmarks for marketing use.

The landing page serves an existing instance. Its primary action is the correct
sign-in or dashboard action for that visitor; self-hosting installation is the
secondary path. The walkthrough should show publishing, access and backend
capabilities before cosmetic settings. Business targets and conversion metrics
are unknown.

## Changelog

- v1 (2026-11-01) — Initial source-grounded context for the canvas and AI workflow positioning refresh; separated verified behavior from inferred audience needs and unknown proof.
