// Build the animated product-tour loop (animated WebP) from the committed dark
// landing/tour screenshots in docs/site/assets/. Output: docs/site/assets/tour.webp
// embedded near the top of the README. Animated WebP (not GIF): GitHub renders it
// inline, it loops, and it stays true-colour and sharp (a GIF's 256-colour palette
// wrecks UI screenshots).
//
// sharp assembles the animation from equal-sized frames via `join: { animated }`
// (no GIF/ffmpeg intermediate, so no palette loss). Run standalone (`pnpm landing:gif`)
// or as the tail of `pnpm landing:screenshots` (which calls buildTourLoop after
// recapturing the frames, so the loop refreshes whenever the preview images do).

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS_DIR = join(root, "docs/site/assets");
const OUT = join(ASSETS_DIR, "tour.webp");

// Tour order: open on the dashboard, then walk the workflow.
const FRAMES = [
  "landing-dashboard.webp",
  "tour-editor.webp",
  "landing-gallery.webp",
  "tour-sharing.webp",
  "tour-capabilities.webp",
  "tour-usage.webp",
  "tour-preview.webp",
  "tour-admin.webp",
];

// Near-native resolution (the capture viewport is 1440x900) so text stays crisp.
const W = 1440;
const H = 900;
const DELAY_MS = 2000;
const QUALITY = 90;

export async function buildTourLoop() {
  const sharp = (await import("sharp")).default;
  mkdirSync(ASSETS_DIR, { recursive: true });

  const paths = FRAMES.map((f) => join(ASSETS_DIR, f)).filter((p) => existsSync(p));
  if (paths.length === 0) {
    console.warn("! no tour frames found - run `pnpm landing:screenshots` first");
    return;
  }

  // Equal-sized true-colour frames; sharp joins them into one animated WebP.
  const frames = await Promise.all(
    paths.map((p) => sharp(p).resize(W, H, { fit: "cover", position: "top" }).png().toBuffer()),
  );

  await sharp(frames, { join: { animated: true } })
    .webp({ quality: QUALITY, effort: 6, loop: 0, delay: frames.map(() => DELAY_MS) })
    .toFile(OUT);

  const kb = (statSync(OUT).size / 1024).toFixed(0);
  console.log(`+ tour loop - ${frames.length} frames -> docs/site/assets/tour.webp (${kb} KB)`);
}

// Run directly (not when imported by screenshots.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  buildTourLoop();
}
