// Capture optimized screenshots of the dashboard, driving headless Chromium
// (Playwright) against a RUNNING dev dashboard in dev auth mode (auto-login),
// then resizing + re-encoding to WebP with sharp into docs/site/assets/.
//
// Two modes (the only differences are settle time, populated-vs-empty data, and
// which screens map to which asset names — both capture in LIGHT theme):
//
//   pnpm docs:screenshots       # docs shots: org-agnostic EMPTY screens
//   pnpm landing:screenshots    # landing shots: populated product tour
//
// The landing shots are the light, populated product imagery the marketing page
// (apps/server/src/http/landing-page.ts) embeds — hero + the product-tour
// carousel (dashboard, editor, gallery, sharing, capabilities, admin, usage).
// Seed generic demo data first so they aren't empty: `pnpm seed:canvases`
// (neutral tool names, @example.com owners — no real org data, so the shots stay
// org-agnostic, R11). The landing capture DISCOVERS a canvas id from the
// dashboard so the canvas-scoped tour screens (editor/sharing/…) work without a
// hard-coded slug. The docs shots stay deliberately empty/light.
//
// NOT part of the CI matrix — it needs a browser + a live server. The optimized
// .webp outputs are committed so the docs + landing render without running this.

import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "docs/site/assets");
const MAX_WIDTH = 1600;

// Where the dev dashboard is reachable. Override for a non-default port pair.
const BASE = process.env.CANVAS_DROP_DASHBOARD_URL ?? "http://localhost:5173";

const LANDING = process.argv.includes("--landing");
// Both docs and landing shots capture in LIGHT theme — the marketing/landing
// imagery reads soft + editorial in light mode (owner preference, 2026-06-19).
const COLOR_SCHEME = "light";
const WEBP_QUALITY = LANDING ? 82 : 80;
// The canvas list / gallery / admin views load data after first paint; networkidle
// can fire before rows render, so the landing (populated) shots wait a beat.
const SETTLE_MS = LANDING ? 1800 : 0;

/** Find a canvas id linked from the dashboard, for the canvas-scoped tour screens.
 *  Prefers a canvas by visible title (so the editor slide showcases a clean,
 *  code-rich demo app) and falls back to the first one. Returns null if none is
 *  seeded (those shots are then skipped). */
async function discoverCanvasId(page, preferTitle) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20000 });
  await page.waitForTimeout(SETTLE_MS || 1200);
  return page.evaluate((title) => {
    const links = Array.from(document.querySelectorAll("a[href]")).filter((a) =>
      /^\/canvases\/[0-9a-f-]+$/.test(a.getAttribute("href") ?? ""),
    );
    const pick =
      (title && links.find((a) => (a.textContent || "").trim().includes(title))) || links[0];
    const href = pick?.getAttribute("href");
    return href ? href.split("/")[2] : null;
  }, preferTitle ?? null);
}

/** Resolve the list of {path, name} shots for the active mode. */
async function resolveShots(page) {
  if (!LANDING) {
    // Keep to screens without seeded data (org-agnostic, R11).
    return [
      { path: "/", name: "dashboard-home.webp" },
      { path: "/new", name: "new-canvas.webp" },
      { path: "/gallery", name: "gallery.webp" },
    ];
  }
  const shots = [
    // Filter BOTH the dashboard and the gallery to the demo apps' unique "showcase"
    // tag (seed-demo-apps) so the hero shots are exactly the 12 real-cover demo apps —
    // no generic seed canvases (generative covers) in frame.
    { path: "/?tag=showcase", name: "landing-dashboard.webp" },
    { path: "/gallery?tag=showcase", name: "landing-gallery.webp" },
    { path: "/admin/settings", name: "tour-admin.webp" },
    // Teams & invites (plan 003): expand the personal "Family" team's roster so the shot
    // tells the invite story — a member plus a not-yet-signed-in Pending row. Seed a team
    // first (seed-canvases creates a personal + org team with a pending invite).
    {
      path: "/teams",
      name: "tour-teams.webp",
      async prepare(page) {
        const members = page
          .locator("li", { hasText: "Family" })
          .getByRole("button", { name: /^Members$/ })
          .first();
        if (await members.count()) {
          await members.click();
          await page.waitForTimeout(400);
        }
      },
    },
  ];
  // Showcase the code-rich Pricing Calculator on the canvas-scoped tour slides — its
  // hand-authored multi-line index.html reads as real, interesting code in the editor.
  const id = await discoverCanvasId(page, "Pricing Calculator");
  if (id) {
    shots.push(
      { path: `/canvases/${id}/editor`, name: "tour-editor.webp" },
      { path: `/canvases/${id}/share`, name: "tour-sharing.webp" },
      { path: `/canvases/${id}/capabilities`, name: "tour-capabilities.webp" },
      { path: `/canvases/${id}/usage`, name: "tour-usage.webp" },
      // The per-canvas preview control (auto/off + custom cover) — scroll the Preview
      // section into view so the framed shot shows the control, not the page top.
      { path: `/canvases/${id}/settings`, name: "tour-preview.webp", scrollTo: "#preview" },
    );
  } else {
    console.warn(
      "! no seeded canvas found — skipping canvas-scoped tour shots. Run `pnpm seed:canvases`.",
    );
  }
  return shots;
}

async function main() {
  let chromium;
  let sharp;
  try {
    ({ chromium } = await import("playwright"));
    sharp = (await import("sharp")).default;
  } catch {
    console.error(
      "Missing deps. Install them first:\n" +
        "  pnpm add -Dw playwright sharp\n" +
        "  pnpm exec playwright install chromium",
    );
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: COLOR_SCHEME,
  });

  // `--only <substr>` captures just the shots whose asset name matches (e.g. `--only teams`)
  // so a single asset can be refreshed without re-shooting — and overwriting — the others.
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const shots = (await resolveShots(page)).filter((s) => !only || s.name.includes(only));
  for (const shot of shots) {
    const url = BASE + shot.path;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      if (SETTLE_MS) await page.waitForTimeout(SETTLE_MS);
      // Optionally run a per-shot prep step (expand a roster, open a section) before framing.
      if (shot.prepare) await shot.prepare(page);
      // Optionally scroll a specific section into view (e.g. the Preview control, which
      // sits below the fold on the settings page) before framing the shot.
      if (shot.scrollTo) {
        await page.evaluate((sel) => {
          document.querySelector(sel)?.scrollIntoView({ block: "start" });
        }, shot.scrollTo);
        await page.waitForTimeout(500);
      }
      const png = await page.screenshot({ fullPage: false });
      const out = join(OUT_DIR, shot.name);
      await sharp(png)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toFile(out);
      const kb = (statSync(out).size / 1024).toFixed(1);
      console.log(`✓ ${shot.path} → docs/site/assets/${shot.name} (${kb} KB)`);
    } catch (err) {
      console.error(`✗ ${shot.path}: ${err.message} (is the dev server running at ${BASE}?)`);
    }
  }

  await browser.close();

  // Landing mode: rebuild the animated product-tour loop from the fresh frames, so
  // the README's tour.webp refreshes whenever the preview images do.
  if (LANDING) {
    const { buildTourLoop } = await import("./landing-gif.mjs");
    await buildTourLoop();
  }
}

main();
