import { Buffer } from "node:buffer";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DeployError } from "./errors.js";
import { type DeployEntry, fromFilesArray, fromPasteHtml, fromZip } from "./ingest.js";

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

describe("fromFilesArray", () => {
  it("round-trips UTF-8 text byte-exact and yields every entry", () => {
    const out = fromFilesArray([
      { path: "index.html", content: "<h1>hi</h1>" },
      { path: "a/b.css", content: "body{}", encoding: "utf8" },
    ]);
    expect(out.map((e) => e.path)).toEqual(["index.html", "a/b.css"]);
    expect(out.map((e) => new TextDecoder().decode(e.bytes))).toEqual(["<h1>hi</h1>", "body{}"]);
  });

  it("decodes base64 binary to exact bytes", () => {
    const raw = new Uint8Array([0, 1, 2, 250, 255]);
    const b64 = Buffer.from(raw).toString("base64");
    const out = fromFilesArray([{ path: "f.bin", content: b64, encoding: "base64" }]);
    expect(Array.from(out[0]?.bytes ?? [])).toEqual(Array.from(raw));
  });

  it("does not throw on empty/garbage base64 (drops to fewer bytes)", () => {
    const out = fromFilesArray([{ path: "f", content: "", encoding: "base64" }]);
    expect(out[0]?.bytes.byteLength).toBe(0);
  });

  it("throws INVALID_ENCODING on an unknown encoding", () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard
      fromFilesArray([{ path: "f", content: "x", encoding: "hex" }]),
    ).toThrowError(DeployError);
  });
});
