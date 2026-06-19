/**
 * Dev seed: 100 realistic, zero-file canvases across several owners, for exercising
 * the gallery + Your-canvases filters / sort / pills (plan 004).
 *
 * Run from the repo root (after `pnpm reset:data` for a clean slate):
 *   pnpm seed:canvases
 *
 * The admin dev user (from .env) owns 70; six other users own the remaining 30.
 * Canvases get varied tags, summaries, and states (shared / listed / templatable /
 * password-protected / never-deployed), and back-dated timestamps so the sort axes
 * are meaningful. No files are uploaded — "published" canvases just get a zero-file
 * ready version so they satisfy the gallery's `current_version_id IS NOT NULL` rule.
 * Deterministic (seeded PRNG) so re-runs produce the same data.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@canvas-drop/shared";
import { sqliteSchema } from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import { generateApiKey, hashApiKey } from "../src/canvas/api-key.js";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { canvasesRepository } from "../src/db/repositories/canvases.js";
import { usersRepository } from "../src/db/repositories/users.js";
import { versionsRepository } from "../src/db/repositories/versions.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const ENV_FILE = join(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const TOTAL = 100;
const ADMIN_OWNS = 70;
const DAY = 86_400_000;

/** Deterministic PRNG (mulberry32) so the seed is reproducible run-to-run. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xca7d40b);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
const chance = (p: number) => rand() < p;

const OTHER_USERS = [
  { name: "Dana Okafor", email: "dana@example.com" },
  { name: "Priya Nair", email: "priya@example.com" },
  { name: "Liam Walsh", email: "liam@example.com" },
  { name: "Sofia Rossi", email: "sofia@example.com" },
  { name: "Noah Kim", email: "noah@example.com" },
  { name: "Aisha Bello", email: "aisha@example.com" },
];

const TITLES = [
  "Q3 Revenue Dashboard",
  "Team Standup Board",
  "Pricing Calculator",
  "Onboarding Survey",
  "Roadmap Timeline",
  "Bug Triage Board",
  "Customer Map",
  "Release Notes",
  "Budget Planner",
  "Feature Flags Demo",
  "Sprint Retro Wall",
  "NPS Tracker",
  "Landing Page Concept",
  "Sales Funnel Viz",
  "Incident Postmortem",
  "Hiring Pipeline",
  "Design Tokens Preview",
  "Churn Cohort Explorer",
  "API Status Page",
  "Meeting Cost Timer",
  "OKR Tracker",
  "Support Queue Monitor",
  "Color Palette Lab",
  "Markdown Notes",
  "Habit Tracker",
  "Expense Splitter",
  "Poll and Vote",
  "Changelog Feed",
  "Mood Board",
  "Latency Heatmap",
  "Inventory Snapshot",
  "Wishlist Board",
  "Release Train Map",
  "Typeface Specimen",
  "Conversion Lab",
  "Kanban Lite",
  "Weather Card",
  "Countdown Timer",
  "Recipe Box",
  "Flashcards",
  "Pomodoro Clock",
  "Unit Converter",
  "QR Generator",
  "Gradient Studio",
  "Standup Notes",
  "Velocity Chart",
  "Heatmap Explorer",
  "Survey Results",
  "Demo Sandbox",
];

const TAGS = [
  "charts",
  "dashboard",
  "finance",
  "marketing",
  "game",
  "tool",
  "docs",
  "demo",
  "internal",
  "prototype",
  "ai",
  "data-viz",
  "form",
  "report",
  "landing",
  "experiment",
  "ops",
  "design",
];

const SUMMARY_LEADS = [
  "A quick",
  "An internal",
  "A shared",
  "A throwaway",
  "A polished",
  "An experimental",
  "A lightweight",
  "A team",
];
const SUMMARY_TAILS = [
  "for the team to poke at.",
  "built during a hack day.",
  "for the weekly review.",
  "to try out an idea.",
  "for the leadership update.",
  "for onboarding new folks.",
  "we keep meaning to retire.",
  "for a customer demo.",
];

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function tagsFor(): string[] {
  const n = 1 + Math.floor(rand() * 4); // 1–4 tags
  const out = new Set<string>();
  while (out.size < n) out.add(pick(TAGS));
  return [...out];
}

interface Profile {
  published: boolean;
  shared: boolean;
  listed: boolean;
  templatable: boolean;
  protectedCanvas: boolean;
}

/** Pick a realistic state mix. `richGallery` (the non-admin owners) leans toward
 *  shared+listed so the gallery has plenty of cross-owner content to filter. */
function profile(richGallery: boolean): Profile {
  const published = chance(richGallery ? 0.92 : 0.86);
  const protectedCanvas = published && chance(0.12);
  let shared = false;
  let listed = false;
  let templatable = false;
  if (published && !protectedCanvas) {
    shared = chance(richGallery ? 0.85 : 0.7);
    if (shared) {
      listed = chance(richGallery ? 0.85 : 0.72);
      if (listed) templatable = chance(0.4);
    }
  }
  return { published, shared, listed, templatable, protectedCanvas };
}

async function main() {
  const config = loadConfig();
  if (config.db.driver !== "sqlite") {
    process.stderr.write(
      `This seed back-dates timestamps via the SQLite schema; current DB driver is "${config.db.driver}". ` +
        "Run it against the local SQLite dev DB.\n",
    );
    process.exit(1);
  }

  const dbClient = makeDb(config);
  await runMigrations(dbClient);
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam (sqlite in dev)
  const drizzle = dbClient.db as any;
  const t = sqliteSchema.canvases;

  // `--if-empty`: used by the dev launcher to populate a FRESH build only —
  // skip (no-op) when the DB already has canvases, so re-running `pnpm dev`
  // never clobbers or duplicates existing data.
  if (process.argv.includes("--if-empty")) {
    const existing = await drizzle.select({ id: t.id }).from(t).limit(1);
    if (existing.length > 0) {
      process.stdout.write("seed:canvases --if-empty: canvases already present — skipping.\n");
      return;
    }
  }

  const users = usersRepository(dbClient);
  const canvases = canvasesRepository(dbClient);
  const versions = versionsRepository(dbClient);

  // Owners: the admin dev user, then six colleagues.
  const { email: adminEmail, name: adminName } = config.auth.dev;
  const admin = await users.upsert({
    providerSub: `dev:${adminEmail}`,
    email: adminEmail,
    name: adminName,
    isAdmin: true,
  });
  const others = await Promise.all(
    OTHER_USERS.map((u) =>
      users.upsert({ providerSub: `dev:${u.email}`, email: u.email, name: u.name, isAdmin: false }),
    ),
  );

  const now = Date.now();
  const byOwner = new Map<string, number>();
  let galleryVisible = 0;
  let neverDeployed = 0;
  let protectedCount = 0;
  const titleCounts = new Map<string, number>();

  for (let i = 0; i < TOTAL; i++) {
    const isAdminCanvas = i < ADMIN_OWNS;
    const owner = isAdminCanvas ? admin : (others[i % others.length] as (typeof others)[number]);
    const p = profile(!isAdminCanvas);

    // Unique-ish title (allow repeats across owners, append a count for the slug).
    const baseTitle = pick(TITLES);
    const seen = (titleCounts.get(baseTitle) ?? 0) + 1;
    titleCounts.set(baseTitle, seen);
    const title = seen > 1 ? `${baseTitle} ${seen}` : baseTitle;
    const slug = `${kebab(baseTitle)}-${i}`;
    const tags = tagsFor();
    const summary = `${pick(SUMMARY_LEADS)} ${tags[0]} canvas ${pick(SUMMARY_TAILS)}`;

    const canvas = await canvases.create({
      ownerId: owner.id,
      slug,
      apiKeyHash: hashApiKey(generateApiKey()),
      title,
    });

    // Zero-file "published" version so listed/shared canvases satisfy the gallery's
    // current_version_id rule without any storage writes.
    if (p.published) {
      const v = await versions.createPending({
        canvasId: canvas.id,
        number: 1,
        createdBy: owner.id,
        source: "folder",
      });
      await versions.markReady(v.id, { fileCount: 0, totalBytes: 0, manifest: {} });
      await canvases.setCurrentVersion(canvas.id, v.id);
    } else {
      neverDeployed++;
    }

    await canvases.updateSettings(canvas.id, {
      // The repo patch keys on `access` (the `shared` boolean→access translation lives in
      // the route's resolveSettingsUpdate, which the seed bypasses). Set access directly,
      // else listed canvases stay `private` and the gallery renders empty.
      access: p.shared ? "whole_org" : "private",
      galleryListed: p.listed,
      galleryTemplatable: p.templatable,
      gallerySummary: summary,
      tags,
    });
    if (p.protectedCanvas) {
      await canvases.setPassword(canvas.id, "$seed$dev-only-placeholder-hash");
      protectedCount++;
    }

    // Back-date timestamps so "Recently updated" / "Newest" sorts and "X days ago"
    // labels look realistic; spread created times across the last ~90 days.
    const ageMs = Math.floor(rand() * 90 * DAY);
    const createdAt = now - ageMs;
    const updatedAt = createdAt + Math.floor(rand() * (now - createdAt));
    await drizzle
      .update(t)
      .set({
        createdAt,
        updatedAt,
        ...(p.listed ? { galleryPublishedAt: updatedAt } : {}),
      })
      .where(eq(t.id, canvas.id));

    byOwner.set(owner.name, (byOwner.get(owner.name) ?? 0) + 1);
    if (p.published && p.shared && p.listed && !p.protectedCanvas) galleryVisible++;
  }

  const ownerLines = [...byOwner.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `    ${name}: ${n}`)
    .join("\n");

  process.stdout.write(
    [
      "",
      `Seeded ${TOTAL} canvases (0 files each).`,
      "",
      "  By owner:",
      ownerLines,
      "",
      `  Gallery-visible (shared + listed + published + unprotected): ${galleryVisible}`,
      `  Never deployed: ${neverDeployed}`,
      `  Password-protected: ${protectedCount}`,
      "",
      "  Start the app with `pnpm dev` and browse /gallery and your canvases to test the filters.",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
