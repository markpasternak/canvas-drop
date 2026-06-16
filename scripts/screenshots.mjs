// Capture optimized screenshots of the dashboard, driving headless Chromium
// (Playwright) against a RUNNING dev dashboard in dev auth mode (auto-login),
// then resizing + re-encoding to WebP with sharp into docs/site/assets/.
//
// Two modes (the only differences are color scheme, settle time, and which
// screens map to which asset names):
//
//   pnpm docs:screenshots       # docs shots: LIGHT, org-agnostic EMPTY screens
//   pnpm landing:screenshots    # landing shots: DARK, populated (seed first)
//
// The landing shots are the dark, populated product imagery the marketing page
// (apps/server/src/http/landing-page.ts) embeds. Seed generic demo data first so
// they aren't empty: `pnpm seed:canvases` (neutral tool names, @example.com
// owners — no real org data, so the shots stay org-agnostic, R11). The docs shots
// stay deliberately empty/light.
//
// NOT part of the CI matrix — it needs a browser + a live server. The optimized
// .webp outputs are committed so the docs + landing render without running this.
//
// Reproducible: `pnpm docs:screenshots` / `pnpm landing:screenshots`.

import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "docs/site/assets");
const MAX_WIDTH = 1600;

// Where the dev dashboard is reachable. Override for a non-default port pair.
const BASE = process.env.CANVAS_DROP_DASHBOARD_URL ?? "http://localhost:5173";

const LANDING = process.argv.includes("--landing");

/** Per-mode capture settings. */
const MODE = LANDING
  ? {
      colorScheme: "dark",
      quality: 82,
      // The canvas list / gallery loads its data after first paint; networkidle can
      // fire before the rows/cards render. Wait so the shot isn't an empty state.
      settleMs: 1800,
      shots: [
        { path: "/", name: "landing-dashboard.webp" },
        { path: "/gallery", name: "landing-gallery.webp" },
      ],
    }
  : {
      colorScheme: "light",
      quality: 80,
      settleMs: 0,
      // Keep to screens without seeded data (org-agnostic, R11).
      shots: [
        { path: "/", name: "dashboard-home.webp" },
        { path: "/new", name: "new-canvas.webp" },
        { path: "/gallery", name: "gallery.webp" },
      ],
    };

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
    colorScheme: MODE.colorScheme,
  });

  for (const shot of MODE.shots) {
    const url = BASE + shot.path;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      if (MODE.settleMs) await page.waitForTimeout(MODE.settleMs);
      const png = await page.screenshot({ fullPage: false });
      const out = join(OUT_DIR, shot.name);
      await sharp(png)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: MODE.quality })
        .toFile(out);
      const kb = (statSync(out).size / 1024).toFixed(1);
      console.log(`✓ ${shot.path} → docs/site/assets/${shot.name} (${kb} KB)`);
    } catch (err) {
      console.error(`✗ ${shot.path}: ${err.message} (is the dev server running at ${BASE}?)`);
    }
  }

  await browser.close();
}

main();
