// Generate the GitHub repo "Social preview" card — the same branded surface as the
// Open Graph card (scripts/og-card.mjs) but at GitHub's recommended 1280×640 (2:1)
// instead of 1200×630. Render a self-contained HTML card in headless Chromium and
// re-encode to PNG with sharp. Reproducible: `node scripts/github-social-card.mjs`.
// Output is committed at docs/site/github-social.png; upload it under
// Settings → General → Social preview. Org-agnostic: no operator-specific data.
//
// NOT part of CI — it needs a browser.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChromiumWithChromeFallback } from "./playwright-launch.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "docs/site/github-social.png");
const W = 1280;
const H = 640;

// Same drop-frame `</>` mark + wordmark, "Drop it in. Share it out." headline (amber
// accent), one-line subhead, and quiet footer as the OG card — on the drenched
// teal->navy "Committed" surface with the warm amber glow + faint grid. Authored in
// OKLCH to match the brand tokens. Spacing retuned for the slightly taller 2:1 frame.
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    position: relative; overflow: hidden;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Inter, system-ui, sans-serif;
    background:
      radial-gradient(95% 120% at 84% -14%, oklch(0.78 0.15 72 / 0.42), transparent 50%),
      radial-gradient(85% 120% at 6% 4%, oklch(0.55 0.12 196 / 0.5), transparent 55%),
      linear-gradient(155deg, oklch(0.31 0.092 205) 0%, oklch(0.2 0.072 214) 55%, oklch(0.14 0.05 224) 100%);
    color: oklch(0.97 0.003 266);
    display: flex; flex-direction: column; justify-content: center;
    padding: 88px 104px;
  }
  .grid {
    position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(oklch(1 0 0 / 0.06) 1px, transparent 1px),
      linear-gradient(90deg, oklch(1 0 0 / 0.06) 1px, transparent 1px);
    background-size: 72px 72px;
    -webkit-mask-image: radial-gradient(120% 85% at 50% 0%, #000 35%, transparent 72%);
    mask-image: radial-gradient(120% 85% at 50% 0%, #000 35%, transparent 72%);
  }
  .brand { position: relative; display: flex; align-items: center; gap: 28px; }
  .mark { width: auto; height: 108px; }
  .word { font-size: 62px; font-weight: 650; letter-spacing: -0.025em; }
  .headline {
    position: relative; margin-top: 44px;
    font-size: 100px; line-height: 0.98; font-weight: 660; letter-spacing: -0.035em;
  }
  .headline .accent { color: oklch(0.82 0.14 75); }
  .subhead {
    position: relative; margin-top: 34px; max-width: 920px;
    font-size: 35px; line-height: 1.3; font-weight: 450; color: oklch(0.74 0.012 266);
  }
  .foot {
    position: relative; margin-top: 50px; font-size: 26px; font-weight: 500;
    letter-spacing: 0.01em; color: oklch(0.7 0.013 266);
  }
  .foot .dot { color: oklch(0.5 0.012 266); margin: 0 14px; }
</style></head><body>
  <div class="grid"></div>
  <div class="brand">
    <svg class="mark" viewBox="158 209 372 432" fill="none" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round">
      <path d="M245 335H218C191.49 335 170 356.49 170 383V581C170 607.51 191.49 629 218 629H470C496.51 629 518 607.51 518 581V383C518 356.49 496.51 335 470 335H443" stroke="oklch(0.97 0.003 266)" stroke-width="24"/>
      <path d="M344 222V392" stroke="oklch(0.78 0.11 195)" stroke-width="27"/>
      <path d="M291 349L344 402L397 349" stroke="oklch(0.78 0.11 195)" stroke-width="27"/>
      <path d="M286 462L241 507L286 552" stroke="oklch(0.78 0.11 195)" stroke-width="25"/>
      <path d="M402 462L447 507L402 552" stroke="oklch(0.78 0.11 195)" stroke-width="25"/>
      <path d="M366 452L326 566" stroke="oklch(0.78 0.11 195)" stroke-width="20"/>
    </svg>
    <span class="word">canvas-drop</span>
  </div>
  <div class="headline">Drop it in.<br><span class="accent">Share it out.</span></div>
  <div class="subhead">Your organization's place to drop &amp; share the tools you build with AI.</div>
  <div class="foot">Open source<span class="dot">·</span>Self-hostable<span class="dot">·</span>MIT</div>
</body></html>`;

async function main() {
  const { chromium } = await import("playwright");
  const sharp = (await import("sharp")).default;

  mkdirSync(dirname(OUT), { recursive: true });
  const browser = await launchChromiumWithChromeFallback(chromium);
  // Render at 2× for crisp edges, then downscale to the exact 1280×640 size.
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await page.setContent(HTML, { waitUntil: "networkidle" });
  const shot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: W, height: H } });
  await browser.close();

  await sharp(shot).resize(W, H, { fit: "fill" }).png({ compressionLevel: 9 }).toFile(OUT);
  console.log(`github-social — ${W}×${H} → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
