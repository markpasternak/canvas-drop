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
import { launchChromiumWithChromeFallback } from "./playwright-launch.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "docs/site/og.png");
const W = 1200;
const H = 630;

// A self-contained branded card matching the marketing hero: the canonical drop-frame
// `</>` mark + wordmark, the "Drop it in. Share it out." headline (amber accent on the
// second line), a one-line subhead, and a quiet footer — on the drenched teal->navy
// "Committed" surface with the warm amber glow + faint grid motif (the landing hero).
// Authored in OKLCH (Chromium renders it) so the teal + amber match the brand tokens.
// Inline everything (no external fonts/assets) so the render is deterministic.
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
  .mark { width: auto; height: 104px; }
  .word { font-size: 60px; font-weight: 650; letter-spacing: -0.025em; }
  .headline {
    position: relative; margin-top: 40px;
    font-size: 96px; line-height: 0.98; font-weight: 660; letter-spacing: -0.035em;
  }
  .headline .accent { color: oklch(0.82 0.14 75); }
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
  const browser = await launchChromiumWithChromeFallback(chromium);
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
