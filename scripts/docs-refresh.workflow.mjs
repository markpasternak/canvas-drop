/**
 * docs-refresh — Claude Code *Workflow-tool* script (NOT a standalone node script).
 *
 * Run it with the Workflow tool:
 *     Workflow({ scriptPath: "scripts/docs-refresh.workflow.mjs" })
 * or via the /docs-refresh skill wrapper. It will NOT do anything under `node`.
 *
 * What it does: treats the CODE as the single source of truth and brings every
 * documentation surface up to par — factually correct against the code AND better
 * written than before. Surfaces covered:
 *   - llms          → docs/site/agents/llms.md (source the docs build folds into /llms.txt)
 *   - doc site      → all of docs/site/**
 *   - dev docs (gh) → README.md, AGENTS.md, CONTRIBUTING.md, SECURITY.md, docs/*.md, .env.example, skill/**
 *   - marketing     → apps/server/src/http/landing-page.ts (COPY ONLY, persuasion lens)
 *
 * Shape: extract code facts (parallel) → rewrite each doc → adversarially verify
 * every claim against source → fix failures → cross-doc coherence pass.
 *
 * AFTER this returns you MUST, from the repo root:
 *   1. pnpm docs:build      (regenerate generated-content.ts + search index + /llms.txt body)
 *   2. pnpm lint && pnpm typecheck && pnpm test   (the landing-page + docs tests are the safety net)
 * The workflow deliberately does NOT touch generated files or run the gate itself.
 *
 * Pass { repoRoot: "/abs/path" } as args to target a specific worktree; defaults to cwd.
 */

export const meta = {
  name: "docs-refresh",
  description:
    "Bring every canvas-drop doc surface up to par from code-as-truth — extract facts, rewrite, adversarially verify each claim, fix, cross-doc coherence. Covers llms, the doc site, GitHub dev docs, and the marketing landing copy.",
  phases: [
    { title: "Extract", detail: "8 parallel fact-extractors read the code and emit fact sheets" },
    { title: "Rewrite", detail: "one rewriter per target doc edits the file in place" },
    { title: "Verify", detail: "adversarial reviewer re-derives every claim from source" },
    { title: "Fix", detail: "apply review findings to docs that failed verification" },
    { title: "Coherence", detail: "cross-doc terminology / status / nav / link consistency" },
  ],
};

const REPO = (typeof args === "object" && args && args.repoRoot) || ".";
const P = (rel) => `${REPO}/${rel}`;

// ───────────────────────── Phase A: fact extraction ─────────────────────────
phase("Extract");

const EXTRACTORS = [
  {
    key: "sdk",
    prompt: `Read the canvas-drop browser SDK at ${P("packages/sdk/src/index.ts")} and ${P("packages/sdk/src/browser-entry.ts")} (and any sibling files). Produce a precise FACT SHEET of the public SDK surface as it exists in code TODAY. Include: the global name(s) (canvasdrop / cd alias), how mode+slug are auto-detected, the EXACT method signatures and return shapes for me(), kv.* (get/set/delete/list/increment) and kv.user.*, files.* (upload/list/delete/url), ai.* (chat/stream + option args + return), realtime.channel(name) and the Channel methods (publish/subscribe/presence/on/close). Then list the complete error-code enum and the CanvasdropError subclasses with each stable .code string. Cite the exact file path + symbol for every claim. If something is NOT in the code, say "not present" — never invent. Return structured markdown.`,
  },
  {
    key: "routes",
    prompt: `Read the canvas-drop server runtime/platform routes under ${P("apps/server/src/routes")} (KV, files, AI, realtime, me/identity — the canvas-side API the SDK calls). Produce a FACT SHEET: a route table with HTTP method, exact path (both URL modes if relevant, e.g. /v1/c/:slug/...), request params/body, success shape, and the error codes each can return. Cite file path + handler for every route. Do not invent routes. Return structured markdown.`,
  },
  {
    key: "deployAuth",
    prompt: `Read ${P("apps/server/src/auth")} and the deploy route(s) under ${P("apps/server/src/routes")} (the deploy contract + Bearer auth). Also read ${P("BUILD_BRIEF.md")} §12.0 and §12.5 and ${P("docs/solutions/2026-06-13-auth-invariant-checklist.md")}. Produce a FACT SHEET covering: (1) the Deploy API contract — method, path, auth header, request shapes (folder/zip/paste), machine-readable response (url, version, file count, warnings, custom slug); (2) the three auth modes (dev, proxy, oidc) and EXACTLY how identity is established in each (JWT JWKS verify vs CANVAS_DROP_TRUSTED_PROXY_IPS trusted headers — the two non-composing proxy trust paths); (3) the five hard security invariants from §12.0. Cite file paths. Return structured markdown.`,
  },
  {
    key: "mcp",
    prompt: `Read the canvas-drop MCP server under ${P("apps/server/src/mcp")} (server.ts, provider.ts, routes.ts) and ${P("docs/site/agents/mcp.md")}. Produce a FACT SHEET of the agent MCP surface as it exists in code TODAY: the exact tool names exposed (whoami, list/get/create_canvas, begin_deploy/add_files/finalize_deploy, deploy_canvas, list_versions, rollback/unpublish, …), each tool's params and return shape, how the MCP server authenticates the agent, the mount path/endpoint, and how it is enabled (on-by-default? config flag?). Cite file path + symbol per tool. Do not invent tools. Return structured markdown.`,
  },
  {
    key: "configDeploy",
    prompt: `Read ${P("packages/shared/src/config/env.ts")}, ${P(".env.example")}, the root + per-package package.json files, ${P("deploy/")} (if present), the Docker/compose packaging (Dockerfile, docker-compose*.yml, ${P("scripts/compose-smoke.sh")}), and ${P("BUILD_BRIEF.md")} §8.3-8.4 + §16. Produce a FACT SHEET: (1) the COMPLETE env-var matrix — for every CANVAS_DROP_* (and LOG_*) var: name, which mode/driver it belongs to, default, required-or-optional, validation; (2) the four pluggable interfaces (DB sqlite/postgres, storage local/s3, url mode path/subdomain, auth dev/proxy/oidc) and their env switches; (3) the full command list from package.json scripts (dev, test/test:sqlite/test:pg, lint, typecheck, build, docs:build/watch/screenshots, purge, seed:*, etc.) with what each does; (4) self-hosting/deploy facts: single Hono process, reverse-proxy/IAP terminates TLS, the Docker image (base, non-root, multi-stage) and the compose stack (Caddy + oauth2-proxy + Dex + postgres + optional minio). Cite file paths; do not invent vars. Return structured markdown.`,
  },
  {
    key: "status",
    prompt: `Determine the GROUND-TRUTH milestone/feature status of canvas-drop as of today. Cross-reference: (a) what code actually exists under ${P("apps/server/src")}, ${P("apps/dashboard/src")}, ${P("packages")}; (b) the Status section of ${P("README.md")}; (c) completion markers in ${P("docs/plans")} and ${P("BUILD_BRIEF.md")} §16. Produce an authoritative LEDGER: for each milestone M1..M10 (and post-v1 features: sharing access ladder, usage stats, server-side filters, docs system, clone-as-template, primitives showcase, custom slugs, MCP server, optimized upload, marketing micro-site) state shipped / in-progress / not-started with the code evidence (file path) that proves it. Explicitly call out every place the prose is wrong vs code. Cite paths. Return structured markdown.`,
  },
  {
    key: "features",
    prompt: `Read ${P("README.md")}, ${P("BUILD_BRIEF.md")} (§5, §6), ${P("PRODUCT.md")}, and the dashboard/editor/capabilities/gallery code under ${P("apps/dashboard")} and ${P("apps/server/src")}. Produce a FACT SHEET of user-facing features that exist TODAY: the deploy paths (drag folder, paste HTML, API/MCP), the dashboard SPA structure (my-canvases, create, detail tabs, settings), the editor + draft/publish version model on content-addressed storage, archiving/soft-delete, clone-as-template, gallery, custom slugs, the sharing access ladder (guest invites + admin-gated public links), usage stats, and the per-canvas capability toggle model (effective = backend AND flag AND op). Cite file paths. Distinguish shipped vs deferred. Return structured markdown.`,
  },
  {
    key: "voice",
    prompt: `Read ${P("PRODUCT.md")}, ${P("DESIGN.md")}, and ${P("BUILD_BRIEF.md")} §5 (personas). Produce an AUDIENCE & VOICE PROFILE reused by every rewriter. Include: (1) the audiences — canvas authors, self-hosting operators/admins, contributors/AI agents, and signed-out marketing visitors — each with their job-to-be-done and what they need; (2) the product voice rules (tone, what to avoid, anti-references, brand do's/don'ts) — and note the established landing-copy norm of NO em-dashes; (3) doc-quality principles: lead with the reader's job, show a runnable example/command early, be concise and scannable, no marketing fluff in reference docs, org-agnostic (no org-specific branding/telemetry, use {base}/localhost placeholders). Return structured markdown.`,
  },
];

const extractResults = await parallel(
  EXTRACTORS.map((e) => () => agent(e.prompt, { label: `extract:${e.key}`, phase: "Extract" })),
);

const facts = {};
EXTRACTORS.forEach((e, i) => {
  facts[e.key] = extractResults[i] || "(extraction failed — treat this domain as unverified)";
});

const factsFor = (keys) =>
  keys
    .concat(["voice"])
    .filter((k, i, a) => a.indexOf(k) === i)
    .map((k) => `===== FACT SHEET: ${k} =====\n${facts[k]}`)
    .join("\n\n");

// ───────────────────────── target inventory (current tree) ─────────────────────────
// lens: 'factual' (default) | 'marketing' | 'contract' (preserve structure, fix only drift)
const FILES = [
  // doc site
  {
    path: "docs/site/index.md",
    domains: ["status", "features"],
    audience: "all",
    note: "Landing/overview. State what ships today accurately.",
  },
  {
    path: "docs/site/quickstart.md",
    domains: ["configDeploy", "features"],
    audience: "authors+operators",
    note: "Clone/install/pnpm dev path. Commands must be exact.",
  },
  {
    path: "docs/site/authoring/create-and-publish.md",
    domains: ["features", "routes", "deployAuth"],
    audience: "authors",
    note: "Deploy paths (drag/paste/API), publish flow, custom slugs.",
  },
  {
    path: "docs/site/authoring/capabilities.md",
    domains: ["features", "sdk"],
    audience: "authors",
    note: "Per-canvas capability toggle/gating model.",
  },
  {
    path: "docs/site/authoring/editor.md",
    domains: ["features"],
    audience: "authors",
    note: "Editor + draft/publish workflow.",
  },
  {
    path: "docs/site/authoring/sharing.md",
    domains: ["features", "deployAuth"],
    audience: "authors",
    note: "Sharing access ladder: guest invites + admin-gated public links.",
  },
  {
    path: "docs/site/sdk/overview.md",
    domains: ["sdk"],
    audience: "authors",
    note: "Five-primitive SDK intro. Global name + auto-detection.",
  },
  {
    path: "docs/site/sdk/kv.md",
    domains: ["sdk", "routes"],
    audience: "authors",
    note: "KV API. Signatures match code exactly.",
  },
  {
    path: "docs/site/sdk/files.md",
    domains: ["sdk", "routes"],
    audience: "authors",
    note: "Files API.",
  },
  {
    path: "docs/site/sdk/identity.md",
    domains: ["sdk", "routes"],
    audience: "authors",
    note: "me() identity.",
  },
  {
    path: "docs/site/sdk/ai.md",
    domains: ["sdk", "routes", "configDeploy"],
    audience: "authors",
    note: "AI primitive: chat/stream, models allowlist, quotas.",
  },
  {
    path: "docs/site/sdk/realtime.md",
    domains: ["sdk", "routes"],
    audience: "authors",
    note: "Realtime channels/presence.",
  },
  {
    path: "docs/site/api/deploy-api.md",
    domains: ["deployAuth", "routes"],
    audience: "authors+agents",
    note: "Deploy API agent contract.",
  },
  {
    path: "docs/site/api/runtime-api.md",
    domains: ["routes", "sdk"],
    audience: "authors+agents",
    note: "Canvas-side runtime endpoints.",
  },
  {
    path: "docs/site/api/errors.md",
    domains: ["sdk", "routes"],
    audience: "authors+agents",
    note: "Error-code enum must match SDK exactly.",
  },
  {
    path: "docs/site/agents/llms.md",
    domains: ["sdk", "routes", "status", "features", "mcp"],
    audience: "agents",
    note: "Agent quick reference; source folded into /llms.txt. Dense, factual.",
  },
  {
    path: "docs/site/agents/mcp.md",
    domains: ["mcp", "deployAuth", "configDeploy"],
    audience: "agents",
    note: "MCP server: tools, auth, enablement. Tool names/params match code.",
  },
  {
    path: "docs/site/agents/skill.md",
    domains: ["sdk", "features", "mcp"],
    audience: "agents",
    note: "Skill download/install guide.",
  },
  {
    path: "docs/site/self-hosting/install.md",
    domains: ["configDeploy"],
    audience: "operators",
    note: "Install steps incl. Docker. Commands exact.",
  },
  {
    path: "docs/site/self-hosting/configuration.md",
    domains: ["configDeploy", "deployAuth"],
    audience: "operators",
    note: "Env reference — every var must exist in code with matching default.",
  },
  {
    path: "docs/site/self-hosting/deploy.md",
    domains: ["configDeploy", "deployAuth"],
    audience: "operators",
    note: "Production deploy: Docker image + compose stack, reverse-proxy. Org-agnostic.",
  },
  {
    path: "docs/site/self-hosting/security-model.md",
    domains: ["deployAuth"],
    audience: "operators",
    note: "Trust boundary + five invariants.",
  },
  // GitHub dev docs
  {
    path: "README.md",
    domains: ["status", "features", "sdk", "configDeploy"],
    audience: "all",
    note: "Top-level README. Status section must match the status ledger.",
  },
  {
    path: "AGENTS.md",
    domains: ["status", "features"],
    audience: "contributors+agents",
    lens: "contract",
    note: "CANONICAL agent contract. ONLY correct factual/status/milestone drift. PRESERVE all workflow rules, the loop, worktree/branch conventions, dependency gates, project rules verbatim. Do NOT restructure. NEVER touch CLAUDE.md (symlink to this file).",
  },
  {
    path: "CONTRIBUTING.md",
    domains: ["status", "configDeploy"],
    audience: "contributors",
    lens: "contract",
    note: "Light touch — fix factual drift (commands, status) only.",
  },
  {
    path: "SECURITY.md",
    domains: ["deployAuth", "status"],
    audience: "all",
    lens: "contract",
    note: "Light touch — fix only factual drift (supported scope, disclosure contact, invariants).",
  },
  {
    path: "docs/agent-workflow.md",
    domains: ["status", "configDeploy"],
    audience: "contributors",
    lens: "contract",
    note: "Light touch — fix factual drift in status/commands only.",
  },
  {
    path: "docs/sdk.md",
    domains: ["sdk", "routes"],
    audience: "authors",
    note: "SDK reference — signatures match code.",
  },
  {
    path: "docs/testing.md",
    domains: ["configDeploy", "status"],
    audience: "contributors",
    note: "Dual-dialect testing + commands must be exact.",
  },
  {
    path: ".env.example",
    domains: ["configDeploy", "deployAuth"],
    audience: "operators",
    lens: "contract",
    note: "COMMENTS/DEFAULTS ONLY: fix inaccurate comments/defaults. Keep it a valid example env file; do not remove vars that exist in config, do not add vars absent from env.ts.",
  },
  // installable skill
  {
    path: "skill/canvas-drop/SKILL.md",
    domains: ["sdk", "features", "routes", "mcp"],
    audience: "agents",
    note: "Installable agent skill: when-to-use, deploy flow, SDK primitives, errors.",
  },
  {
    path: "skill/canvas-drop/examples/poll.md",
    domains: ["sdk", "routes"],
    audience: "agents",
    note: "Example poll canvas — code must use real SDK signatures.",
  },
  // marketing
  {
    path: "apps/server/src/http/landing-page.ts",
    domains: ["features", "status"],
    audience: "signed-out marketing visitors",
    lens: "marketing",
    note: 'Public landing copy. Edit COPY STRINGS ONLY (SITE object: tagline/eyebrow/headline/subhead, value-prop arrays, section copy). NEVER touch CSS, markup structure, animation, SEO/OG tags, or strings asserted by landing-page.test.ts (e.g. "Open canvas-drop", hrefs, og:* tags). No em-dashes.',
  },
];

// ───────────────────────── Phases B/C/D: per-file pipeline ─────────────────────────
phase("Rewrite");

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    clean: {
      type: "boolean",
      description:
        "true if every factual claim is verified against source AND the doc serves its audience well",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string", description: "the claim or passage in the doc" },
          problem: {
            type: "string",
            description: "why it is wrong / unverifiable / poor for the audience",
          },
          sourcePath: {
            type: "string",
            description: "the source file that contradicts or should support it",
          },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          fix: { type: "string", description: "concrete correction to apply" },
        },
        required: ["claim", "problem", "severity", "fix"],
      },
    },
  },
  required: ["clean", "findings"],
};

const rewritePrompt = (file) => {
  const common = `Repo root is your current working directory.\nFile to edit: ${P(file.path)}\nPrimary audience: ${file.audience}\nFile-specific guidance: ${file.note}\n\n`;
  if (file.lens === "marketing") {
    return (
      `You are rewriting the COPY of the canvas-drop public marketing landing page so it is honest, sharp, and persuasive for a signed-out visitor.\n\n` +
      common +
      `RULES:\n` +
      `1. Read the current file. Edit ONLY the human-readable copy strings (the SITE config object — tagline/eyebrow/headline/subhead — the value-prop arrays, and section copy inside the template literals).\n` +
      `2. NEVER change CSS, layout/markup structure, animation, JS, SEO/OG/JSON-LD tags, or any string the test file asserts (open the sibling *.test.ts and preserve every asserted literal: e.g. "Open canvas-drop", hrefs like /docs and /auth/login, og:*/twitter:* tags).\n` +
      `3. Every claim must be TRUE against the fact sheets — no vaporware, no features that are not shipped. If the fact sheet says a feature is deferred, do not imply it exists.\n` +
      `4. Quality bar: lead with the value, concrete over abstract, scannable, confident not hypey. Apply the product voice. NO em-dashes (established norm) — use periods or commas.\n` +
      `5. Keep it valid TypeScript; do not break the build. Edit in place.\n\n` +
      `${factsFor(file.domains)}\n\nReturn a short summary of the copy you changed and why.`
    );
  }
  const contract = file.lens === "contract";
  return (
    `You are bringing one canvas-drop documentation file up to par: ACCURATE against the code (not stale prose), RELEVANT, and genuinely USEFUL for its audience.\n\n` +
    common +
    `STEPS:\n` +
    `1. Read the current file.\n` +
    `2. Use the FACT SHEETS below as ground truth. Code is the source of truth — if the file disagrees, the file is wrong; fix it.\n` +
    (contract
      ? `3. CONTRACT FILE — light touch: correct ONLY factual drift (signatures, routes, env vars, defaults, commands, milestone/status). PRESERVE structure, ordering, workflow rules, and voice verbatim. Do NOT restructure or rewrite for style.\n`
      : `3. Rewrite for correctness AND quality: fix every signature/route/env-var/default/command/status claim; lead with the reader's job; put a runnable example or exact command early; make it scannable; keep terminology consistent (canvasdrop/cd, the five primitive names); be concise and org-agnostic ({base}/localhost placeholders, no org-specific branding/telemetry).\n`) +
    `4. Never invent anything unsupported by the fact sheets. If a sheet says "not present", do not document it.\n` +
    `5. Edit the file IN PLACE. Preserve frontmatter/format. For docs/site, do NOT add/remove pages, edit _nav.json, or edit generated files (apps/server/src/docs/generated-content.ts).\n\n` +
    `${factsFor(file.domains)}\n\nReturn a short summary of what you changed and why.`
  );
};

const verifyPrompt = (file) => {
  if (file.lens === "marketing") {
    return (
      `You are an adversarial reviewer of the canvas-drop marketing landing COPY at ${P(file.path)}.\n\n` +
      `Open the file AND its sibling *.test.ts. Check, against the fact sheets and code:\n` +
      `1. HONESTY (P0/P1): every product claim maps to a SHIPPED feature — flag any vaporware or overstated capability with the contradicting source path.\n` +
      `2. TEST/STRUCTURE SAFETY (P0): no asserted literal was changed (og:*/twitter:* tags, "Open canvas-drop", hrefs), and no CSS/markup/animation/JS was altered. Flag any such change.\n` +
      `3. NORMS (P1): no em-dashes in copy; voice matches PRODUCT/DESIGN.\n` +
      `4. COPY QUALITY (P1/P2): clarity, hierarchy, persuasion for a signed-out visitor.\n` +
      `Return clean=true only if there are zero P0/P1 issues. Otherwise list findings with sourcePath + a concrete fix.`
    );
  }
  return (
    `You are an adversarial, code-grounded reviewer. Verify the rewritten doc at ${P(file.path)} against the actual source.\n\n` +
    `Read the doc, then OPEN THE CITED SOURCE FILES and re-derive EVERY factual claim: SDK signatures (${P("packages/sdk/src/index.ts")}), routes (${P("apps/server/src/routes")}), MCP tools (${P("apps/server/src/mcp")}), env vars + defaults (${P("packages/shared/src/config/env.ts")}, ${P(".env.example")}), commands (package.json), and milestone/feature status (code presence). Judge audience fit and example correctness for: ${file.audience}.\n\n` +
    `Calibration: factual inaccuracies (wrong signature/route/env/default/status, broken example) = P0. Material clarity/structure/missing-example/audience-fit problems that leave the doc below par = P1 (must fix). Subjective wording nits = P2.\n\n` +
    `Return clean=true only if there are zero P0 AND zero P1 issues. Otherwise list findings, each with the contradicting/supporting sourcePath and a concrete fix.`
  );
};

const results = await pipeline(
  FILES,
  // Stage 1: rewrite
  (file) => agent(rewritePrompt(file), { label: `rewrite:${file.path}`, phase: "Rewrite" }),
  // Stage 2: adversarial review
  (_summary, file) =>
    agent(verifyPrompt(file), {
      label: `verify:${file.path}`,
      phase: "Verify",
      schema: REVIEW_SCHEMA,
    }),
  // Stage 3: fix the P0/P1 findings (bounded)
  async (review, file) => {
    if (!review || review.clean || !review.findings || review.findings.length === 0) {
      return { path: file.path, status: "clean", findings: 0 };
    }
    const blocking = review.findings.filter((f) => f.severity === "P0" || f.severity === "P1");
    if (blocking.length === 0)
      return { path: file.path, status: "clean", findings: 0, notes: review.findings.length };
    const findingsText = blocking
      .map(
        (f, i) =>
          `${i + 1}. [${f.severity}] ${f.claim}\n   problem: ${f.problem}\n   source: ${f.sourcePath || "(see code)"}\n   fix: ${f.fix}`,
      )
      .join("\n");
    await agent(
      `Apply these review findings to ${P(file.path)}. Each fix must be grounded in the cited source — verify against code before editing, then Edit the file. Respect the file's lens (${file.lens || "factual"}): for 'marketing' edit copy only and keep test-asserted strings; for 'contract' make minimal factual corrections only. Do not introduce new unverified claims.\n\nFINDINGS:\n${findingsText}\n\nAfter editing, briefly confirm each finding is resolved.`,
      { label: `fix:${file.path}`, phase: "Fix" },
    );
    return { path: file.path, status: "fixed", findings: blocking.length };
  },
);

// ───────────────────────── Coherence pass ─────────────────────────
phase("Coherence");

const fileList = FILES.map((f) => f.path).join(", ");
const coherence = await agent(
  `Final cross-document coherence pass over the canvas-drop docs just edited (repo root = cwd). Check the whole set together and FIX issues directly (Edit the files):\n\n` +
    `1. Terminology consistency everywhere: global name (canvasdrop vs cd), the five primitive names (KV, files, AI, identity, realtime), route naming, MCP tool names.\n` +
    `2. No contradictory claims between pages (a signature shown differently in sdk/kv.md vs docs/sdk.md vs the runtime-api page; an MCP tool named differently in agents/mcp.md vs the skill).\n` +
    `3. Milestone/feature status is identical everywhere it appears: README.md, AGENTS.md, docs/site/index.md, docs/site/agents/llms.md, and the marketing copy in apps/server/src/http/landing-page.ts (no claim there that the docs/status ledger contradicts).\n` +
    `4. docs/site/_nav.json still matches the set of pages (none added/removed); internal cross-links resolve; marketing links (/docs, /terms, /privacy, GitHub) point at real targets.\n` +
    `5. Do NOT edit generated files (apps/server/src/docs/generated-content.ts, the built /llms.txt) — those are rebuilt by \`pnpm docs:build\`. Do NOT touch CLAUDE.md (symlink). For landing-page.ts edit copy only.\n\n` +
    `Files in scope: ${fileList}\n\nReturn a summary of inconsistencies found and how you resolved them.`,
  { label: "coherence", phase: "Coherence" },
);

const cleanCount = results.filter((r) => r && r.status === "clean").length;
const fixedCount = results.filter((r) => r && r.status === "fixed").length;
return {
  filesProcessed: results.length,
  cleanFirstPass: cleanCount,
  requiredFixes: fixedCount,
  perFile: results,
  coherenceSummary: coherence,
  reminder: 'Now run: pnpm docs:build && pnpm lint && pnpm typecheck && pnpm test',
}
