// Generate the social share card (Open Graph / Twitter) by rendering a branded
// 1200×630 HTML card in headless Chromium (Playwright) and re-encoding to PNG
// with sharp. Reproducible: `pnpm og:build`. The committed PNG is served publicly
// at `/og.png` (docs router) and is the single shared og:image / twitter:image for
// every surface — the landing, docs, legal pages, and the signed-out / per-canvas
// social-preview cards. Org-agnostic: no operator-specific data on the card.
//
// NOT part of CI — it needs a browser. The output PNG is committed so the meta
// tags resolve without running this.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "docs/site/og.png");
const W = 1200;
const H = 630;

// A self-contained branded card matching the marketing hero: the box-drop mark +
// wordmark, the "Drop it in. Share it out." headline (accent on the second line),
// a one-line subhead, and a quiet footer — on the dark brand surface with the same
// indigo-violet radial glow + faint grid motif. Authored in OKLCH (Chromium
// renders it) so the accent matches the dashboard tokens exactly. Inline
// everything (no external fonts/assets) so the render is deterministic.
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    position: relative; overflow: hidden;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Inter, system-ui, sans-serif;
    background:
      radial-gradient(120% 95% at 85% -12%, oklch(0.515 0.214 274 / 0.45), transparent 60%),
      radial-gradient(90% 75% at 6% 4%, oklch(0.6 0.16 286 / 0.20), transparent 55%),
      linear-gradient(180deg, oklch(0.165 0.008 266), oklch(0.115 0.006 266));
    color: oklch(0.97 0.003 266);
    display: flex; flex-direction: column; justify-content: center;
    padding: 78px 96px;
  }
  .grid {
    position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(oklch(1 0 0 / 0.06) 1px, transparent 1px),
      linear-gradient(90deg, oklch(1 0 0 / 0.06) 1px, transparent 1px);
    background-size: 68px 68px;
    -webkit-mask-image: radial-gradient(120% 85% at 50% 0%, #000 35%, transparent 72%);
    mask-image: radial-gradient(120% 85% at 50% 0%, #000 35%, transparent 72%);
  }
  .brand { position: relative; display: flex; align-items: center; gap: 26px; }
  .mark { width: 92px; height: 92px; }
  .word { font-size: 60px; font-weight: 650; letter-spacing: -0.025em; }
  .headline {
    position: relative; margin-top: 40px;
    font-size: 96px; line-height: 0.98; font-weight: 660; letter-spacing: -0.035em;
  }
  .headline .accent { color: oklch(0.78 0.15 274); }
  .subhead {
    position: relative; margin-top: 30px; max-width: 860px;
    font-size: 33px; line-height: 1.3; font-weight: 450; color: oklch(0.74 0.012 266);
  }
  .foot {
    position: relative; margin-top: 46px; font-size: 25px; font-weight: 500;
    letter-spacing: 0.01em; color: oklch(0.7 0.013 266);
  }
  .foot .dot { color: oklch(0.5 0.012 266); margin: 0 14px; }
</style></head><body>
  <div class="grid"></div>
  <div class="brand">
    <svg class="mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M14 37h-4a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5h28a5 5 0 0 1 5 5v21a5 5 0 0 1-5 5h-4" stroke="oklch(0.97 0.003 266)" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
      <path d="M24 14v16.5m-7-7 7 7 7-7" stroke="oklch(0.72 0.16 274)" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
      <path d="M18 40h12" stroke="oklch(0.72 0.16 274)" stroke-linecap="round" stroke-width="4.75"/>
    </svg>
    <span class="word">canvas-drop</span>
  </div>
  <div class="headline">Drop it in.<br><span class="accent">Share it out.</span></div>
  <div class="subhead">Your organization's place to drop &amp; share the tools you build with AI.</div>
  <div class="foot">Open source<span class="dot">·</span>Self-hostable<span class="dot">·</span>MIT</div>
</body></html>`;

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

  mkdirSync(dirname(OUT), { recursive: true });
  const browser = await chromium.launch();
  // Render at 2× for crisp edges, then downscale to the exact 1200×630 OG size.
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await page.setContent(HTML, { waitUntil: "networkidle" });
  const shot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: W, height: H } });
  await browser.close();

  await sharp(shot).resize(W, H, { fit: "fill" }).png({ compressionLevel: 9 }).toFile(OUT);
  console.log(`og:build — ${W}×${H} → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
