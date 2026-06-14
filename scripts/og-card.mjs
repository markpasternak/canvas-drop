// Generate the social share card (Open Graph / Twitter) by rendering a branded
// 1200×630 HTML card in headless Chromium (Playwright) and re-encoding to PNG
// with sharp. Reproducible: `pnpm og:build`. The committed PNG is served publicly
// at `/og.png` (docs router) and referenced by og:image / twitter:image on the
// public pages (docs, legal). Org-agnostic: no operator-specific data on the card.
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

// A self-contained branded card: the box-drop mark + wordmark, a product tagline,
// and a quiet footer, on the dark brand surface with a soft accent glow. Inline
// everything (no external fonts/assets) so the render is deterministic.
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Inter, system-ui, sans-serif;
    background:
      radial-gradient(circle at 16% 18%, rgba(96,165,250,0.20), transparent 46%),
      radial-gradient(circle at 92% 96%, rgba(37,99,235,0.16), transparent 40%),
      #0b0b0d;
    color: #f4f4f5;
    display: flex; flex-direction: column; justify-content: center;
    padding: 84px 96px;
  }
  .brand { display: flex; align-items: center; gap: 28px; }
  .mark { width: 116px; height: 116px; }
  .word { font-size: 80px; font-weight: 700; letter-spacing: -0.03em; }
  .tagline {
    margin-top: 48px; max-width: 920px;
    font-size: 46px; line-height: 1.18; font-weight: 600; letter-spacing: -0.02em;
    color: #e4e4e7;
  }
  .tagline b { color: #93c5fd; font-weight: 700; }
  .foot {
    margin-top: 52px; font-size: 26px; font-weight: 500; letter-spacing: 0.01em;
    color: #a1a1aa;
  }
  .foot .dot { color: #52525b; margin: 0 14px; }
</style></head><body>
  <div class="brand">
    <svg class="mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M14 37h-4a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5h28a5 5 0 0 1 5 5v21a5 5 0 0 1-5 5h-4" stroke="#f4f4f5" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
      <path d="M24 14v16.5m-7-7 7 7 7-7" stroke="#60a5fa" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
      <path d="M18 40h12" stroke="#60a5fa" stroke-linecap="round" stroke-width="4.75"/>
    </svg>
    <span class="word">canvas-drop</span>
  </div>
  <div class="tagline">Deploy and share small web <b>artifacts</b> — no build step, no secrets in the page.</div>
  <div class="foot">Open-source<span class="dot">·</span>Self-hostable<span class="dot">·</span>MIT</div>
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
