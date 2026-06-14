import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const svgSource = await readFile(path.join(publicDir, "brand/canvasdrop-mark.svg"), "utf8");
const svg = Buffer.from(
  svgSource
    .replaceAll('stroke="var(--frame)"', 'stroke="#111418"')
    .replaceAll('stroke="var(--drop)"', 'stroke="#2563eb"'),
);

async function tileIcon(size, outputPath) {
  const mark = await sharp(svg)
    .resize(Math.round(size * 0.72), Math.round(size * 0.72), { fit: "contain" })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: "#f5f5f2",
    },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

await Promise.all([
  tileIcon(32, path.join(publicDir, "favicon-32x32.png")),
  tileIcon(180, path.join(publicDir, "apple-touch-icon.png")),
  tileIcon(192, path.join(publicDir, "brand/canvasdrop-mark-192.png")),
  tileIcon(512, path.join(publicDir, "brand/canvasdrop-mark-512.png")),
]);

console.log("Generated canvas-drop brand icons.");
