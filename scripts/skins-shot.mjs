// Capture the dashboard in two design skins and composite them side-by-side into
// ONE marketing image (docs/site/assets/landing-skins.webp) the landing embeds to
// show off the admin-flippable skin layer. Drives the RUNNING dev dashboard with
// Playwright (dev auth auto-login), exactly like screenshots.mjs: light theme,
// the populated dashboard grid, so it matches the other product shots.
//
//   pnpm dev                # in another terminal
//   pnpm skins:shot         # writes docs/site/assets/landing-skins.webp
//
// The skin is a global admin setting, so this flips it via the admin API between
// captures and RESTORES the original at the end. The .webp is committed.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChromiumWithChromeFallback } from "./playwright-launch.mjs";

const BASE = process.env.CANVAS_DROP_DASHBOARD_URL ?? "http://localhost:5173";
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs/site/assets");

// editorial (today's default, deep-teal serif) vs canvas (violet, bold Geist) —
// the widest visible range: "same app, your look".
const SKINS = [
  { key: "editorial", label: "Editorial" },
  { key: "canvas", label: "Canvas" },
];

async function setSkin(page, value) {
  await page.evaluate(async (v) => {
    await fetch("/api/admin/config/core.designSkin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ value: v }),
    });
  }, value);
}

async function main() {
  let chromium;
  let sharp;
  try {
    ({ chromium } = await import("playwright"));
    sharp = (await import("sharp")).default;
  } catch {
    console.error(
      "Needs playwright + sharp:\n  pnpm add -Dw playwright sharp\n  pnpm exec playwright install chromium",
    );
    process.exit(1);
  }

  const browser = await launchChromiumWithChromeFallback(chromium);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  // Establish the dev-auth session, remember the original skin to restore later.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20000 });
  const original = await page.evaluate(() =>
    fetch("/api/me", { credentials: "include" })
      .then((r) => r.json())
      .then((m) => m.designSkin),
  );

  const panels = [];
  for (const skin of SKINS) {
    await setSkin(page, skin.key);
    // The full, populated grid shows the skin's accent, typography, radius, and cards.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(900); // let cards + fonts settle
    panels.push({ png: await page.screenshot({ fullPage: false }), label: skin.label });
  }

  await setSkin(page, original); // leave the instance as we found it
  await browser.close();

  // Composite: two panels side by side on a dark-navy card, each labelled.
  const PANEL_W = 1100; // display width per panel
  const resized = await Promise.all(
    panels.map(async (p) => {
      const buf = await sharp(p.png).resize({ width: PANEL_W }).png().toBuffer();
      const meta = await sharp(buf).metadata();
      return { buf, label: p.label, w: meta.width, h: meta.height };
    }),
  );
  const H = Math.max(...resized.map((r) => r.h));
  const PAD = 40;
  const GAP = 40;
  const LABEL_H = 56;
  const totalW = PAD + resized[0].w + GAP + resized[1].w + PAD;
  const totalH = PAD + H + LABEL_H + PAD;

  const labelSvg = `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
  <style> text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; } </style>
  <text x="${PAD}" y="${PAD + H + 38}" font-size="30" font-weight="700" fill="#e8eaf0">${resized[0].label}</text>
  <text x="${PAD + resized[0].w + GAP}" y="${PAD + H + 38}" font-size="30" font-weight="700" fill="#e8eaf0">${resized[1].label}</text>
  <text x="${totalW - PAD}" y="${PAD + H + 38}" font-size="22" fill="#8b93a7" text-anchor="end">One platform · admin-flippable design skins</text>
</svg>`;

  await sharp({
    create: {
      width: totalW,
      height: totalH,
      channels: 4,
      background: { r: 11, g: 14, b: 20, alpha: 1 },
    },
  })
    .composite([
      { input: resized[0].buf, left: PAD, top: PAD },
      { input: resized[1].buf, left: PAD + resized[0].w + GAP, top: PAD },
      { input: Buffer.from(labelSvg), left: 0, top: 0 },
    ])
    .webp({ quality: 84 })
    .toFile(join(ASSETS_DIR, "landing-skins.webp"));

  console.log(`wrote ${join(ASSETS_DIR, "landing-skins.webp")} (${totalW}×${totalH})`);
}

await main();
