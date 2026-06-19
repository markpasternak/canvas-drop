/**
 * Dev seed: a handful of REAL, self-contained demo canvases (actual index.html
 * content, not zero-file rows) so the screenshot pipeline can capture authentic
 * preview covers for the marketing/landing imagery (`pnpm landing:screenshots`).
 *
 * Run from the repo root, AFTER the volume seed, against the SQLite dev DB:
 *   pnpm reset:data && pnpm seed:canvases && pnpm seed:demo-apps
 *
 * It also flips the admin screenshots toggle on (`config.screenshots.enabled`),
 * deploys each app as a published + gallery-listed canvas owned by the dev admin
 * with the newest timestamps (so they top the dashboard + gallery), and enqueues a
 * capture job per canvas. Start `pnpm dev` with `CANVAS_DROP_SCREENSHOTS=on` and the
 * in-process worker drains the queue, producing real covers. Org-agnostic content
 * + @example.com owner (R11). Deterministic.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@canvas-drop/shared";
import { sqliteSchema } from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { generateApiKey, hashApiKey } from "../src/canvas/api-key.js";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { canvasesRepository } from "../src/db/repositories/canvases.js";
import { draftsRepository } from "../src/db/repositories/drafts.js";
import { screenshotsRepository } from "../src/db/repositories/screenshots.js";
import { settingsRepository } from "../src/db/repositories/settings.js";
import { usersRepository } from "../src/db/repositories/users.js";
import { versionsRepository } from "../src/db/repositories/versions.js";
import { deployEngine } from "../src/deploy/engine.js";
import { makeStorage } from "../src/storage/factory.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const ENV_FILE = join(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const silent = pino({ level: "silent" });

/** Shared modern shell so the apps read as a cohesive product, with per-app accents. */
function page(title: string, accent: string, bg: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{--accent:${accent};}
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:${bg};
  -webkit-font-smoothing:antialiased;padding:32px;min-height:100vh}
h1{font-size:22px;font-weight:700;letter-spacing:-.02em}
.muted{color:#64748b}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.row{display:flex;gap:16px}.col{flex:1}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:color-mix(in srgb,var(--accent) 14%,#fff);color:var(--accent)}
.bar{height:10px;border-radius:999px;background:#eef2f7;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent);border-radius:999px}
</style></head><body>${body}</body></html>`;
}

interface DemoApp {
  title: string;
  tags: string[];
  summary: string;
  templatable: boolean;
  html: string;
}

/** Hand-authored (not via the minifying `page()` shell) so the editor tour slide
 *  shows clean, multi-line, syntax-highlightable HTML + CSS + JS — a real little
 *  interactive tool, not a wall of minified markup. The screenshot pipeline pins the
 *  canvas-scoped tour shots to this app (see scripts/screenshots.mjs). */
const PRICING_CALCULATOR_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pricing Calculator</title>
    <style>
      :root {
        --accent: #0891b2;
        --ink: #0f172a;
        --muted: #64748b;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: var(--ink);
        background: #ecfeff;
        -webkit-font-smoothing: antialiased;
        min-height: 100vh;
        padding: 32px;
      }
      h1 { font-size: 22px; letter-spacing: -0.02em; }
      .muted { color: var(--muted); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 760px; }
      .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; }
      label { display: block; font-size: 13px; margin: 14px 0 6px; }
      label:first-of-type { margin-top: 0; }
      input[type="range"] { width: 100%; accent-color: var(--accent); }
      select, input[type="number"] {
        width: 100%;
        padding: 9px 11px;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        font: inherit;
      }
      .total { background: linear-gradient(160deg, #0891b2, #0e7490); color: #fff; border: none; }
      .total .amount { font-size: 44px; font-weight: 800; letter-spacing: -0.03em; margin: 6px 0; }
      .line {
        display: flex;
        justify-content: space-between;
        padding: 8px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.18);
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <header style="margin-bottom: 22px">
      <h1>Pricing Calculator</h1>
      <p class="muted">Estimate your team's monthly plan</p>
    </header>

    <div class="grid">
      <div class="card">
        <label for="seats">Team seats — <strong id="seatsOut">24</strong></label>
        <input id="seats" type="range" min="1" max="200" value="24" />

        <label for="mau">Monthly active users</label>
        <input id="mau" type="number" value="12000" />

        <label for="tier">Support tier</label>
        <select id="tier">
          <option value="0">Community</option>
          <option value="240" selected>Priority</option>
          <option value="600">Dedicated</option>
        </select>
      </div>

      <div class="card total">
        <div style="opacity: 0.85; font-size: 13px">Estimated monthly</div>
        <div class="amount" id="amount">$0</div>
        <div style="opacity: 0.85; font-size: 13px; margin-bottom: 16px">
          billed annually · save 18%
        </div>
        <div class="line"><span>Base platform</span><span id="base">$0</span></div>
        <div class="line"><span>Seats</span><span id="seatsCost">$0</span></div>
        <div class="line"><span>Usage</span><span id="usage">$0</span></div>
        <div class="line"><span>Support</span><span id="support">$0</span></div>
      </div>
    </div>

    <script>
      const PLATFORM = 1200; // flat base, per month
      const PER_SEAT = 40;
      const PER_1K_MAU = 45;

      const $ = (id) => document.getElementById(id);
      const money = (n) => "$" + Math.round(n).toLocaleString();

      function recalc() {
        const seats = Number($("seats").value);
        const mau = Number($("mau").value) || 0;
        const support = Number($("tier").value);

        const seatsCost = seats * PER_SEAT;
        const usage = (mau / 1000) * PER_1K_MAU;
        const total = PLATFORM + seatsCost + usage + support;

        $("seatsOut").textContent = seats;
        $("base").textContent = money(PLATFORM);
        $("seatsCost").textContent = money(seatsCost);
        $("usage").textContent = money(usage);
        $("support").textContent = money(support);
        $("amount").textContent = money(total);
      }

      for (const id of ["seats", "mau", "tier"]) {
        $(id).addEventListener("input", recalc);
      }
      recalc();
    </script>
  </body>
</html>
`;

const APPS: DemoApp[] = [
  {
    title: "Q3 Revenue Dashboard",
    tags: ["dashboard", "data-viz", "finance"],
    summary: "Live revenue, pipeline, and growth at a glance for the weekly review.",
    templatable: true,
    html: page(
      "Q3 Revenue Dashboard",
      "#2563eb",
      "#f1f5f9",
      `<header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
<div><h1>Q3 Revenue</h1><p class="muted">Updated moments ago</p></div><span class="pill">Live</span></header>
<div class="row" style="margin-bottom:18px">
${[
  ["MRR", "$248.5k", "+12.4%"],
  ["New customers", "1,284", "+8.1%"],
  ["Churn", "1.9%", "-0.3%"],
  ["Pipeline", "$1.12M", "+19%"],
]
  .map(
    ([k, v, d]) =>
      `<div class="card col"><div class="muted" style="font-size:13px">${k}</div>
<div style="font-size:26px;font-weight:700;margin-top:4px">${v}</div>
<div style="color:#16a34a;font-size:13px;font-weight:600;margin-top:2px">${d}</div></div>`,
  )
  .join("")}
</div>
<div class="row">
<div class="card col" style="flex:2"><div class="muted" style="font-size:13px;margin-bottom:10px">Revenue, last 12 weeks</div>
<svg viewBox="0 0 520 160" width="100%" height="160" preserveAspectRatio="none">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity=".35"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>
<path d="M0,130 L40,120 L80,124 L120,96 L160,104 L200,80 L240,84 L280,58 L320,64 L360,44 L400,40 L440,26 L480,30 L520,14 L520,160 L0,160 Z" fill="url(#g)"/>
<path d="M0,130 L40,120 L80,124 L120,96 L160,104 L200,80 L240,84 L280,58 L320,64 L360,44 L400,40 L440,26 L480,30 L520,14" fill="none" stroke="#2563eb" stroke-width="2.5"/></svg></div>
<div class="card col"><div class="muted" style="font-size:13px;margin-bottom:10px">By segment</div>
${[
  ["Enterprise", 78],
  ["Mid-market", 54],
  ["SMB", 36],
  ["Self-serve", 22],
]
  .map(
    ([k, v]) =>
      `<div style="margin:10px 0"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>${k}</span><span class="muted">${v}%</span></div><div class="bar"><span style="width:${v}%"></span></div></div>`,
  )
  .join("")}
</div></div>`,
    ),
  },
  {
    title: "Sprint Board",
    tags: ["tool", "ops"],
    summary: "A lightweight kanban for the team standup — drag work across columns.",
    templatable: true,
    html: page(
      "Sprint Board",
      "#7c3aed",
      "#f5f3ff",
      `<header style="margin-bottom:20px"><h1>Sprint 24 · Board</h1><p class="muted">14 issues · 3 in review</p></header>
<div class="row">
${[
  ["To do", "#94a3b8", ["Audit onboarding flow", "Spec export to CSV", "Triage flaky tests"]],
  ["In progress", "#7c3aed", ["Realtime presence", "Billing webhook retries", "Search ranking"]],
  ["Done", "#16a34a", ["Dark mode", "Avatar uploads", "Rate-limit headers"]],
]
  .map(
    ([
      title,
      color,
      cards,
    ]) => `<div class="col" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:14px">
<div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;margin-bottom:12px"><span style="width:8px;height:8px;border-radius:50%;background:${color}"></span>${title}</div>
${(cards as string[])
  .map(
    (c, i) =>
      `<div style="background:#fff;border:1px solid #eef2f7;border-radius:10px;padding:11px;margin-bottom:9px;box-shadow:0 1px 2px rgba(15,23,42,.05)">
<div style="font-size:13px;font-weight:600">${c}</div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><span class="pill" style="font-size:11px">${["api", "ui", "infra"][i % 3]}</span><span style="width:20px;height:20px;border-radius:50%;background:color-mix(in srgb,${color} 30%,#fff)"></span></div></div>`,
  )
  .join("")}</div>`,
  )
  .join("")}
</div>`,
    ),
  },
  {
    title: "Pricing Calculator",
    tags: ["tool", "finance"],
    summary: "Plug in seats and usage to see the monthly total update instantly.",
    templatable: true,
    html: PRICING_CALCULATOR_HTML,
  },
  {
    title: "Color Palette Lab",
    tags: ["design", "tool"],
    summary: "Generate and lock cohesive palettes for the next brand refresh.",
    templatable: true,
    html: page(
      "Color Palette Lab",
      "#db2777",
      "#fdf2f8",
      `<header style="margin-bottom:20px"><h1>Palette Lab</h1><p class="muted">Sunset · 5-color scheme</p></header>
<div class="row" style="margin-bottom:18px">
${[
  ["#0f172a", "Ink"],
  ["#db2777", "Rose"],
  ["#f59e0b", "Amber"],
  ["#10b981", "Mint"],
  ["#6366f1", "Indigo"],
]
  .map(
    ([
      hex,
      name,
    ]) => `<div class="col" style="border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
<div style="height:120px;background:${hex}"></div>
<div style="padding:10px 12px;background:#fff"><div style="font-weight:700;font-size:13px">${name}</div><div class="muted" style="font-family:ui-monospace,monospace;font-size:12px">${hex}</div></div></div>`,
  )
  .join("")}
</div>
<div class="card"><div class="muted" style="font-size:13px;margin-bottom:10px">Tints & shades</div>
<div style="display:flex;border-radius:10px;overflow:hidden">
${["#831843", "#9d174d", "#be185d", "#db2777", "#ec4899", "#f472b6", "#f9a8d4", "#fbcfe8"].map((h) => `<div style="flex:1;height:44px;background:${h}"></div>`).join("")}
</div></div>`,
    ),
  },
  {
    title: "Onboarding Poll",
    tags: ["form", "data-viz"],
    summary: "Live results from the new-hire onboarding survey, updated as votes land.",
    templatable: false,
    html: page(
      "Onboarding Poll",
      "#16a34a",
      "#f0fdf4",
      `<header style="margin-bottom:22px"><h1>How was onboarding?</h1><p class="muted">312 responses · live</p></header>
<div class="card" style="max-width:680px">
${[
  ["Loved it — smooth and clear", 58],
  ["Good, a few rough edges", 27],
  ["Okay, took some figuring out", 11],
  ["Confusing in places", 4],
]
  .map(
    ([
      k,
      v,
    ]) => `<div style="margin:16px 0"><div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px"><span style="font-weight:600">${k}</span><span class="muted">${v}%</span></div>
<div class="bar" style="height:14px"><span style="width:${v}%"></span></div></div>`,
  )
  .join("")}
</div>`,
    ),
  },
  {
    title: "Roadmap Timeline",
    tags: ["docs", "ops"],
    summary: "Quarter-at-a-glance roadmap with workstreams and milestones.",
    templatable: true,
    html: page(
      "Roadmap Timeline",
      "#ea580c",
      "#fff7ed",
      `<header style="margin-bottom:20px"><h1>Roadmap · H2</h1><p class="muted">5 workstreams · Jul → Dec</p></header>
<div class="card">
<div style="display:flex;color:#94a3b8;font-size:12px;font-weight:600;margin-bottom:10px;padding-left:140px">
${["Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m) => `<div style="flex:1">${m}</div>`).join("")}</div>
${[
  ["Realtime v2", 0, 3, "#ea580c"],
  ["Mobile app", 1, 4, "#2563eb"],
  ["Billing revamp", 2, 5, "#7c3aed"],
  ["Search & AI", 3, 6, "#16a34a"],
  ["Compliance", 4, 6, "#0891b2"],
]
  .map(
    ([name, start, end, color]) => `<div style="display:flex;align-items:center;margin:9px 0">
<div style="width:140px;font-size:13px;font-weight:600">${name}</div>
<div style="flex:1;position:relative;height:22px;background:#f1f5f9;border-radius:6px">
<div style="position:absolute;left:${(Number(start) / 6) * 100}%;width:${((Number(end) - Number(start)) / 6) * 100}%;top:3px;bottom:3px;background:${color};border-radius:6px;opacity:.9"></div></div></div>`,
  )
  .join("")}
</div>`,
    ),
  },
  {
    title: "Weather Card",
    tags: ["demo", "tool"],
    summary: "A clean weather widget — a tiny canvas that does one thing well.",
    templatable: false,
    html: page(
      "Weather",
      "#0284c7",
      "#e0f2fe",
      `<div style="max-width:420px;margin:24px auto">
<div class="card" style="background:linear-gradient(160deg,#0ea5e9,#0369a1);color:#fff;border:none;padding:26px">
<div style="display:flex;justify-content:space-between;align-items:start">
<div><div style="font-size:15px;opacity:.9">San Francisco</div><div style="font-size:64px;font-weight:800;letter-spacing:-.04em;line-height:1">18°</div>
<div style="opacity:.9">Partly cloudy · feels like 17°</div></div>
<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6"><circle cx="8" cy="9" r="3.5" fill="#fde047" stroke="#fde047"/><path d="M6 16h11a3 3 0 0 0 0-6 4.5 4.5 0 0 0-8.6-1.5A3.2 3.2 0 0 0 6 16Z" fill="#fff" stroke="#fff"/></svg></div>
<div style="display:flex;justify-content:space-between;margin-top:24px;border-top:1px solid rgba(255,255,255,.2);padding-top:16px">
${[
  ["Mon", "19°"],
  ["Tue", "21°"],
  ["Wed", "20°"],
  ["Thu", "17°"],
  ["Fri", "16°"],
]
  .map(
    ([d, t]) =>
      `<div style="text-align:center"><div style="font-size:12px;opacity:.85">${d}</div><div style="font-weight:700;margin-top:6px">${t}</div></div>`,
  )
  .join("")}
</div></div></div>`,
    ),
  },
  {
    title: "Markdown Notes",
    tags: ["docs", "tool"],
    summary: "Split-pane markdown scratchpad — type on the left, preview on the right.",
    templatable: true,
    html: page(
      "Markdown Notes",
      "#475569",
      "#f8fafc",
      `<header style="margin-bottom:18px"><h1>Notes</h1><p class="muted">meeting-notes.md · autosaved</p></header>
<div class="row">
<div class="card col" style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#334155;white-space:pre-wrap;line-height:1.7">– # Launch checklist
–
– ## Before ship
– - [x] Copy review
– - [x] Screenshots refreshed
– - [ ] Final QA pass
–
– > Ship Thursday, 9am PT.
–
– **Owner:** platform team</div>
<div class="card col">
<h2 style="font-size:20px;font-weight:700;margin-bottom:4px">Launch checklist</h2>
<h3 style="font-size:15px;font-weight:700;color:#475569;margin:14px 0 6px">Before ship</h3>
<div style="font-size:14px;line-height:2">
<div>✅ Copy review</div><div>✅ Screenshots refreshed</div><div>⬜ Final QA pass</div></div>
<blockquote style="border-left:3px solid #cbd5e1;padding-left:12px;color:#64748b;margin:14px 0">Ship Thursday, 9am PT.</blockquote>
<div style="font-size:14px"><strong>Owner:</strong> platform team</div></div>
</div>`,
    ),
  },
  {
    title: "Team Directory",
    tags: ["people", "tool"],
    summary: "Who's who on the team — names, roles, and who owns what, in one place.",
    templatable: true,
    html: page(
      "Team Directory",
      "#7c3aed",
      "#faf5ff",
      `<header style="margin-bottom:18px"><h1>Team Directory</h1><p class="muted">platform org · 6 people</p></header>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
${(
  [
    ["AR", "Alex Rivera", "Eng lead", "#7c3aed"],
    ["PN", "Priya Nair", "Design", "#db2777"],
    ["DO", "Dana Okafor", "Product", "#0891b2"],
    ["LW", "Liam Walsh", "Backend", "#16a34a"],
    ["SR", "Sofia Rossi", "Frontend", "#ea580c"],
    ["NK", "Noah Kim", "Data", "#475569"],
  ] as Array<[string, string, string, string]>
)
  .map(
    ([ini, name, role, color]) =>
      `<div class="card" style="text-align:center"><div style="width:46px;height:46px;border-radius:999px;background:${color};color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;margin:0 auto 9px">${ini}</div><div style="font-weight:600">${name}</div><div class="muted" style="font-size:13px">${role}</div></div>`,
  )
  .join("")}
</div>`,
    ),
  },
  {
    title: "Service Status",
    tags: ["ops", "status"],
    summary: "A status board for the services your team runs — green until something isn't.",
    templatable: true,
    html: page(
      "Service Status",
      "#16a34a",
      "#f0fdf4",
      `<header style="margin-bottom:18px"><h1>Service Status</h1><p class="muted">all systems · updated just now</p></header>
<div class="card" style="padding:6px 18px">
${(
  [
    ["API gateway", "Operational", "#16a34a"],
    ["Dashboard", "Operational", "#16a34a"],
    ["Realtime hub", "Operational", "#16a34a"],
    ["Deploy worker", "Degraded", "#d97706"],
    ["AI proxy", "Operational", "#16a34a"],
  ] as Array<[string, string, string]>
)
  .map(
    ([svc, state, color]) =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:13px 0;border-bottom:1px solid #f1f5f9"><span style="font-weight:600">${svc}</span><span style="display:inline-flex;align-items:center;gap:7px;font-size:13px;color:${color}"><span style="width:8px;height:8px;border-radius:999px;background:${color}"></span>${state}</span></div>`,
  )
  .join("")}
</div>`,
    ),
  },
  {
    title: "Expense Splitter",
    tags: ["tool", "finance"],
    summary: "Split a shared bill across the team and see who owes what at a glance.",
    templatable: true,
    html: page(
      "Expense Splitter",
      "#ea580c",
      "#fff7ed",
      `<header style="margin-bottom:18px"><h1>Team Lunch</h1><p class="muted">4 people · split evenly</p></header>
<div class="row">
<div class="card col">
${(
  [
    ["Tacos", "$48.00"],
    ["Drinks", "$22.50"],
    ["Tip", "$14.00"],
  ] as Array<[string, string]>
)
  .map(
    ([item, amt]) =>
      `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f1f5f9"><span>${item}</span><span class="muted">${amt}</span></div>`,
  )
  .join("")}
<div style="display:flex;justify-content:space-between;padding:12px 0 0;font-weight:700"><span>Total</span><span>$84.50</span></div>
</div>
<div class="card col" style="background:linear-gradient(160deg,#ea580c,#c2410c);color:#fff;border:none">
<div style="font-size:13px;opacity:.85">Each person owes</div>
<div style="font-size:40px;font-weight:800;letter-spacing:-.03em;margin:6px 0">$21.13</div>
<div style="font-size:13px;opacity:.85">Alex · Priya · Dana · Noah</div>
</div>
</div>`,
    ),
  },
  {
    title: "KPI Scorecard",
    tags: ["dashboard", "data-viz"],
    summary: "This quarter's targets vs. actuals, one tile per metric — no spreadsheet needed.",
    templatable: true,
    html: page(
      "KPI Scorecard",
      "#0d9488",
      "#f0fdfa",
      `<header style="margin-bottom:18px"><h1>Q3 Scorecard</h1><p class="muted">targets vs. actuals · 4 metrics</p></header>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
${(
  [
    ["Active users", "8,420", "+12%", 82],
    ["Revenue", "$1.12M", "+8%", 68],
    ["NPS", "54", "+6", 74],
    ["Churn", "2.1%", "-0.4", 90],
  ] as Array<[string, string, string, number]>
)
  .map(
    ([metric, value, delta, pct]) =>
      `<div class="card"><div class="muted" style="font-size:13px">${metric}</div><div style="font-size:30px;font-weight:800;letter-spacing:-.02em;margin:4px 0">${value}</div><div style="font-size:13px;color:#16a34a;margin-bottom:10px">${delta} vs target</div><div class="bar"><span style="width:${pct}%"></span></div></div>`,
  )
  .join("")}
</div>`,
    ),
  },
];

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function main() {
  const config = loadConfig();
  if (config.db.driver !== "sqlite") {
    process.stderr.write(`Run against the SQLite dev DB (driver is "${config.db.driver}").\n`);
    process.exit(1);
  }

  const dbClient = makeDb(config);
  await runMigrations(dbClient);
  const storage = makeStorage(config);
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam (sqlite in dev)
  const drizzle = dbClient.db as any;
  const t = sqliteSchema.canvases;

  const users = usersRepository(dbClient);
  const canvases = canvasesRepository(dbClient);
  const versions = versionsRepository(dbClient);
  const drafts = draftsRepository(dbClient);
  const jobs = screenshotsRepository(dbClient);
  const settings = settingsRepository(dbClient);
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });

  // Flip the admin screenshots toggle on so the in-process worker captures (the env
  // CANVAS_DROP_SCREENSHOTS=on is the other half of the effective gate).
  await settings.set("config.screenshots.enabled", true);

  const { email, name } = config.auth.dev;
  const admin = await users.upsert({
    providerSub: `dev:${email}`,
    email,
    name,
    isAdmin: true,
  });
  // Colleague owners so the gallery (which excludes the VIEWER's own canvases) shows
  // real covers too — each app is deployed once for the admin (→ dashboard) and once
  // for a rotating colleague (→ gallery).
  const colleagues = await Promise.all(
    [
      { name: "Dana Okafor", email: "dana@example.com" },
      { name: "Priya Nair", email: "priya@example.com" },
      { name: "Liam Walsh", email: "liam@example.com" },
      { name: "Sofia Rossi", email: "sofia@example.com" },
      { name: "Noah Kim", email: "noah@example.com" },
      { name: "Aisha Bello", email: "aisha@example.com" },
    ].map((u) =>
      users.upsert({ providerSub: `dev:${u.email}`, email: u.email, name: u.name, isAdmin: false }),
    ),
  );

  const now = Date.now();
  let n = 0;
  let count = 0;
  /** Deploy one app as a published, gallery-listed canvas owned by `owner`. */
  async function seedOne(app: DemoApp, owner: { id: string }, slug: string) {
    const canvas = await canvases.create({
      ownerId: owner.id,
      slug,
      apiKeyHash: hashApiKey(generateApiKey()),
      title: app.title,
    });
    await engine.deploy(
      canvas,
      "folder",
      [{ path: "index.html", bytes: new TextEncoder().encode(app.html) }],
      owner.id,
    );
    await canvases.updateSettings(canvas.id, {
      access: "whole_org",
      galleryListed: true,
      galleryTemplatable: app.templatable,
      description: app.summary,
      // Tag every demo app with a unique "showcase" tag (not in the seed-canvases
      // pool) so the landing gallery shot can isolate exactly these 12 real-cover
      // apps via ?tag=showcase — no generic seed canvases bleed into the frame.
      tags: [...app.tags, "showcase"],
    });
    // Newest timestamps (minutes apart) so the demo apps top the dashboard + gallery —
    // exactly the rows the marketing shots frame.
    const ts = now - n * 4 * 60_000;
    n++;
    await drizzle
      .update(t)
      .set({ createdAt: ts, updatedAt: ts, galleryPublishedAt: ts })
      .where(eq(t.id, canvas.id));
    const live = await canvases.findById(canvas.id);
    if (live?.currentVersionId) await jobs.enqueue(canvas.id, live.currentVersionId);
    count++;
  }

  // One distinct canvas per app (the gallery includes the viewer's own canvases, so a
  // dual-owner deploy would show the same design twice). Owners alternate admin/colleague
  // so the gallery has varied owners AND the admin's dashboard shows several real covers.
  for (let i = 0; i < APPS.length; i++) {
    const app = APPS[i] as DemoApp;
    const owner =
      i % 2 === 0 ? admin : (colleagues[Math.floor(i / 2) % colleagues.length] as { id: string });
    await seedOne(app, owner, `${kebab(app.title)}-demo`);
    process.stdout.write(`  ✓ ${app.title}\n`);
  }

  process.stdout.write(
    `\nSeeded ${count} real demo canvases (${APPS.length} apps × admin + colleague) + enabled ` +
      `screenshots. Start \`CANVAS_DROP_SCREENSHOTS=on pnpm dev\` and the worker captures covers.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
