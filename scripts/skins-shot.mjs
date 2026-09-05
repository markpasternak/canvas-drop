// Capture the dashboard in two design skins and composite them side-by-side into
// ONE reusable marketing image (docs/site/assets/landing-skins.webp) showing
// the admin-flippable skin layer. Drives the RUNNING dev dashboard with
// Playwright (dev auth auto-login), exactly like screenshots.mjs: light theme,
// the populated dashboard grid, so it matches the other product shots.
//
//   pnpm dev                # in another terminal
//   pnpm skins:shot         # writes docs/site/assets/landing-skins.webp
//
// The skin is a global admin setting, so this flips it via the admin API between
// captures and RESTORES the original at the end. The .webp is committed.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { oklchToHex } from "../packages/shared/src/brand/contrast.ts";
import { BRAND_TOKENS } from "../packages/shared/src/brand/tokens.ts";
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
    const response = await fetch("/api/admin/config/core.designSkin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ value: v }),
    });
    if (!response.ok) throw new Error(`Could not set skin: ${response.status}`);
  }, value);
}

// Keep capture/cleanup separate from image composition so failure paths are testable.
export async function captureSkinPanels(browser) {
  const panels = [];
  const errors = [];
  let page;
  let original;
  let changed = false;
  try {
    page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: "light",
    });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20000 });
    original = await page.evaluate(async () => {
      const response = await fetch("/api/admin/config", { credentials: "include" });
      if (!response.ok) throw new Error(`Could not read original skin: ${response.status}`);
      const { fields } = await response.json();
      const field = fields.find((f) => f.key === "core.designSkin");
      if (
        !field ||
        typeof field.overridden !== "boolean" ||
        !["editorial", "canvas", "studio", "workshop"].includes(field.value)
      ) {
        throw new Error("Could not read the original design-skin setting");
      }
      // Empty clears the temporary override when the original came from env/default.
      return field.overridden ? field.value : "";
    });
    for (const skin of SKINS) {
      changed = true; // Even a failed response may have applied the setting.
      await setSkin(page, skin.key);
      await page.goto(`${BASE}/?tag=showcase`, { waitUntil: "networkidle", timeout: 20000 });
      await page.locator("main h1").first().waitFor({ state: "visible" });
      await page.evaluate(() => document.fonts.ready);
      const filters = page.getByRole("button", { name: /^Filters/ });
      if ((await filters.getAttribute("aria-expanded")) === "true") await filters.click();
      await page.waitForTimeout(900);
      panels.push({ png: await page.screenshot({ fullPage: false }), label: skin.label });
    }
  } catch (error) {
    errors.push(error);
  } finally {
    if (changed) {
      try {
        await setSkin(page, original);
      } catch (error) {
        errors.push(
          new Error("Could not restore the original skin; check Admin > Settings", {
            cause: error,
          }),
        );
      }
    }
    try {
      await browser.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Skin capture or cleanup failed");
  return panels;
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
  const panels = await captureSkinPanels(browser);

  // Composite: two panels side by side on the shared graphite surface, each labelled.
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
  <text x="${PAD}" y="${PAD + H + 38}" font-size="30" font-weight="700" fill="${oklchToHex(BRAND_TOKENS.dark.fg)}">${resized[0].label}</text>
  <text x="${PAD + resized[0].w + GAP}" y="${PAD + H + 38}" font-size="30" font-weight="700" fill="${oklchToHex(BRAND_TOKENS.dark.fg)}">${resized[1].label}</text>
  <text x="${totalW - PAD}" y="${PAD + H + 38}" font-size="22" fill="${oklchToHex(BRAND_TOKENS.dark.muted)}" text-anchor="end">One platform · admin-flippable design skins</text>
</svg>`;

  await sharp({
    create: {
      width: totalW,
      height: totalH,
      channels: 4,
      background: oklchToHex(BRAND_TOKENS.dark.canvas),
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
