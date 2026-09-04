// Canonical SVG geometry -> editable downloads, icons, and social artwork.
// Node 24's native type stripping lets asset scripts read the same geometry as the app.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { brandMarkSvg } from "../packages/shared/src/brand/logo.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "apps/dashboard/public");
const light = { frame: "#20303c", drop: "#0c7b88" };
const dark = { frame: "#f3f3f6", drop: "#56c9d3" };
const colors = `<style>:root{color-scheme:light dark;--frame:${light.frame};--drop:${light.drop}}@media(prefers-color-scheme:dark){:root{--frame:${dark.frame};--drop:${dark.drop}}}</style>`;

function mark({ compact = false, adaptive = false, ...options } = {}) {
  return brandMarkSvg({
    compact,
    ...light,
    ...options,
    ...(adaptive ? { frame: "var(--frame)", drop: "var(--drop)" } : {}),
    svgAttrs: 'xmlns="http://www.w3.org/2000/svg"',
  })
    .replace('aria-hidden="true"', 'role="img" aria-label="canvas-drop"')
    .replace(/(<svg[^>]+>)/, `$1<title>canvas-drop</title>${adaptive ? colors : ""}`);
}

export async function buildIcons() {
  mkdirSync(join(publicDir, "brand"), { recursive: true });
  writeFileSync(join(publicDir, "brand/canvasdrop-mark.svg"), `${mark({ adaptive: true })}\n`);
  writeFileSync(join(publicDir, "favicon.svg"), `${mark({ compact: true, adaptive: true })}\n`);
  const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 72" role="img" aria-label="canvas-drop"><title>canvas-drop</title>${colors}<g transform="translate(6 8) scale(1.75)">${brandMarkSvg({ frame: "var(--frame)", drop: "var(--drop)", svgAttrs: 'width="32" height="32"' })}</g><text x="78" y="47" fill="var(--frame)" font-family="Geist, Arial, sans-serif" font-size="38" font-weight="500" letter-spacing="-1.1">canvas-drop</text></svg>`;
  writeFileSync(join(publicDir, "brand/canvasdrop-logo.svg"), `${wordmark}\n`);
  for (const [file, size, compact] of [
    ["favicon-32x32.png", 32, true],
    ["apple-touch-icon.png", 180, false],
    ["brand/canvasdrop-mark-192.png", 192, false],
    ["brand/canvasdrop-mark-512.png", 512, false],
  ]) {
    const padding = size > 32 ? Math.round(size * 0.16) : 0;
    await sharp(Buffer.from(mark({ compact })))
      .resize(size - padding * 2, size - padding * 2)
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: "#f7f4ed",
      })
      .flatten({ background: "#f7f4ed" })
      .png()
      .toFile(join(publicDir, file));
  }
}

async function textLayer(text, font, size, color) {
  // Pango cannot load the app's WOFF2 assets on every platform. Use explicit
  // serif/sans fallback families for static artwork; web surfaces self-host Geist/Newsreader.
  const family = font === "newsreader" ? "Newsreader, Georgia, serif" : "Geist, Arial, sans-serif";
  return sharp({
    text: {
      text: `<span foreground="${color}">${text}</span>`,
      font: `${family} ${size}`,
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer();
}

export async function buildSocialCards() {
  for (const [file, width, height] of [
    ["og.png", 1200, 630],
    ["github-social.png", 1280, 640],
  ]) {
    const base = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f7f4ed"/><path d="M76 157H${width - 76}" stroke="#d6d9d4"/><svg x="76" y="54" width="64" height="64">${brandMarkSvg(light)}</svg></svg>`;
    await sharp(Buffer.from(base))
      .composite([
        { input: await textLayer("canvas-drop", "geist", 36, light.frame), left: 160, top: 70 },
        {
          input: await textLayer("From an artifact", "newsreader", 78, light.frame),
          left: 76,
          top: 207,
        },
        {
          input: await textLayer("to a tool your team uses.", "newsreader", 78, light.drop),
          left: 76,
          top: 300,
        },
        {
          input: await textLayer(
            "A shared home. Controlled access. Room to keep building.",
            "geist",
            27,
            "#52646b",
          ),
          left: 80,
          top: 448,
        },
        {
          input: await textLayer("Open source  ·  Self-hostable  ·  MIT", "geist", 21, "#52646b"),
          left: 80,
          top: height - 76,
        },
      ])
      .png()
      .toFile(join(root, "docs/site", file));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildIcons();
  await buildSocialCards();
  console.log("Brand SVGs, icons, and social cards generated from the canonical mark.");
}
