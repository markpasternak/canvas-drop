// Capture optimized screenshots of the dashboard for the docs (U6). Drives
// headless Chromium (Playwright) against a RUNNING dev dashboard in dev auth
// mode (auto-login as the dev user), then resizes + re-encodes to WebP with sharp
// into docs/site/assets/. Reproducible: `pnpm docs:screenshots`.
//
// NOT part of the CI matrix — it needs a browser + a live server. The optimized
// .webp outputs are committed so the docs render without running this.
//
// Capture only screens free of operator-specific or seeded data (org-agnostic, R11).

import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "docs/site/assets");
const MAX_WIDTH = 1600;
const WEBP_QUALITY = 80;

// Where the dev dashboard is reachable. Override for a non-default port pair.
const BASE = process.env.CANVAS_DROP_DASHBOARD_URL ?? "http://localhost:5173";

/** Routes to capture → output asset name. Keep to screens without seeded data. */
const SHOTS = [
  { path: "/", name: "dashboard-home.webp" },
  { path: "/new", name: "new-canvas.webp" },
  { path: "/gallery", name: "gallery.webp" },
];

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  for (const shot of SHOTS) {
    const url = BASE + shot.path;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
      const png = await page.screenshot({ fullPage: false });
      const out = join(OUT_DIR, shot.name);
      await sharp(png)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toFile(out);
      const kb = (statSync(out).size / 1024).toFixed(1);
      console.log(
        `✓ ${shot.path} → docs/site/assets/${shot.name} (${kb} KB, from ${(png.length / 1024).toFixed(1)} KB PNG)`,
      );
    } catch (err) {
      console.error(`✗ ${shot.path}: ${err.message} (is the dev server running at ${BASE}?)`);
    }
  }

  await browser.close();
}

main();
