import { Buffer } from "node:buffer";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DeployError } from "./errors.js";
import { type DeployEntry, fromPasteHtml, fromZip } from "./ingest.js";

/** Build a ZIP buffer from a {path: string-or-bytes} map. */
function makeZip(files: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(files));
}
const enc = (s: string) => new TextEncoder().encode(s);

async function collect(gen: AsyncGenerator<DeployEntry>): Promise<DeployEntry[]> {
  const out: DeployEntry[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("fromPasteHtml", () => {
  it("produces a single index.html", () => {
    const [entry] = fromPasteHtml("<h1>hi</h1>");
    expect(entry?.path).toBe("index.html");
    expect(new TextDecoder().decode(entry?.bytes)).toContain("hi");
  });
});

describe("fromZip", () => {
  it("streams entries with their bytes", async () => {
    const zip = makeZip({
      "index.html": enc("<h1>home</h1>"),
      "assets/app.js": enc("console.log(1)"),
    });
    const entries = await collect(fromZip(zip));
    const byPath = Object.fromEntries(
      entries.map((e) => [e.path, new TextDecoder().decode(e.bytes)]),
    );
    expect(byPath["index.html"]).toContain("home");
    expect(byPath["assets/app.js"]).toContain("console.log");
  });

  it("yields entries one at a time (memory bound — never two buffered)", async () => {
    const zip = makeZip({ "a.txt": enc("a"), "b.txt": enc("b"), "c.txt": enc("c") });
    let inFlight = 0;
    let maxInFlight = 0;
    for await (const _e of fromZip(zip)) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); // simulate async processing
      inFlight--;
    }
    expect(maxInFlight).toBe(1);
  });

  it("rejects a zip-bomb (declared uncompressedSize over the cap) before inflating", async () => {
    // 26 MB of zeros compresses tiny, but its uncompressedSize header exceeds 25 MB.
    const big = new Uint8Array(26 * 1024 * 1024);
    const zip = makeZip({ "huge.bin": big });
    await expect(collect(fromZip(zip))).rejects.toMatchObject({ code: "ZIP_BOMB_REJECTED" });
  });

  it("throws INVALID_ZIP on a non-zip buffer", async () => {
    await expect(collect(fromZip(Buffer.from("not a zip")))).rejects.toBeInstanceOf(DeployError);
  });
});
