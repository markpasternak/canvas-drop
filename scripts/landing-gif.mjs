// Build the animated product-tour loop (animated WebP) from the committed dark
// landing/tour screenshots in docs/site/assets/. Output: docs/site/assets/tour.webp
// embedded near the top of the README. Animated WebP (not GIF): GitHub renders it
// inline and it is far smaller and sharper than a GIF.
//
// sharp 0.35 cannot assemble an animated image from raw frames, so this normalizes
// each frame with sharp, encodes a high-quality palettized loop with ffmpeg
// (palettegen/paletteuse → animated GIF), then lets sharp re-encode that animated
// GIF to the smaller, GitHub-inline animated WebP. ffmpeg is a local-only
// requirement, like Playwright is for the screenshots (brew install ffmpeg).
//
// Run standalone (`pnpm landing:gif`) or as the tail of `pnpm landing:screenshots`
// (which calls buildTourLoop after recapturing the frames, so the loop refreshes
// whenever the preview images do).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

const W = 1280;
const H = 800; // 16:10 — matches the 1440x900 capture viewport
const SECONDS_PER_FRAME = 2;

export async function buildTourLoop() {
  const sharp = (await import("sharp")).default;
  mkdirSync(ASSETS_DIR, { recursive: true });

  const paths = FRAMES.map((f) => join(ASSETS_DIR, f)).filter((p) => existsSync(p));
  if (paths.length === 0) {
    console.warn("! no tour frames found - run `pnpm landing:screenshots` first");
    return;
  }
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
    console.warn("! ffmpeg not found - skipping tour.webp (install: brew install ffmpeg)");
    return;
  }

  // Normalize every frame to the same W x H PNG in a temp dir, numbered for ffmpeg.
  const tmp = mkdtempSync(join(tmpdir(), "cd-tour-"));
  try {
    let i = 1;
    for (const p of paths) {
      const n = String(i++).padStart(2, "0");
      await sharp(p)
        .resize(W, H, { fit: "cover", position: "top" })
        .png()
        .toFile(join(tmp, `${n}.png`));
    }

    // ffmpeg → a high-quality palettized animated GIF (palettegen/paletteuse), infinite loop.
    const gifPath = join(tmp, "tour.gif");
    const res = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-framerate",
        `1/${SECONDS_PER_FRAME}`,
        "-start_number",
        "1",
        "-i",
        join(tmp, "%02d.png"),
        "-vf",
        "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
        "-loop",
        "0",
        gifPath,
      ],
      { stdio: "ignore" },
    );
    if (res.status !== 0) {
      console.warn("! ffmpeg failed to encode the tour loop");
      return;
    }

    // Re-encode the animated GIF to a smaller, sharper animated WebP (GitHub-inline).
    await sharp(gifPath, { animated: true }).webp({ quality: 72, effort: 5, loop: 0 }).toFile(OUT);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const kb = (statSync(OUT).size / 1024).toFixed(0);
  console.log(`+ tour loop - ${paths.length} frames -> docs/site/assets/tour.webp (${kb} KB)`);
}

// Run directly (not when imported by screenshots.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  buildTourLoop();
}
