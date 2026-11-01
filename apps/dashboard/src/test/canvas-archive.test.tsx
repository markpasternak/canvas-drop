import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../../server/src/deploy/errors.js";
import {
  archiveText,
  compareArchives,
  readCanvasArchive,
  readUploadArchive,
  UPLOAD_ARCHIVE_LIMITS,
  UPLOAD_ARCHIVE_MAX_BYTES,
} from "../lib/canvas-archive.js";

describe("bounded canvas archive inspection", () => {
  it("preserves paths, ignores hidden files, and compares bytes without executing source", () => {
    const before = readCanvasArchive(
      zipSync({
        "index.html": strToU8("<script>throw 1</script>"),
        "assets/main.css": strToU8("body{}"),
        ".env": strToU8("secret"),
      }),
    );
    const after = readCanvasArchive(
      zipSync({ "index.html": strToU8("<h1>New</h1>"), "new.txt": strToU8("new") }),
    );
    expect(before.map((file) => file.path)).toEqual(["assets/main.css", "index.html"]);
    expect(archiveText(before[1])).toContain("<script>");
    expect(compareArchives(before, after)).toEqual([
      { path: "assets/main.css", kind: "removed" },
      { path: "index.html", kind: "changed" },
      { path: "new.txt", kind: "added" },
    ]);
  });

  it("rejects unsafe and colliding paths", () => {
    expect(() => readCanvasArchive(zipSync({ "../secret": strToU8("x") }))).toThrow(/leaves/);
    expect(() => readCanvasArchive(zipSync({ "/root.html": strToU8("x") }))).toThrow(/absolute/);
    expect(() =>
      readCanvasArchive(zipSync({ "./index.html": strToU8("a"), "index.html": strToU8("b") })),
    ).toThrow(/same canvas path/);
  });

  it("checks central-directory sizes before inflating and limits displayed text", () => {
    const zip = zipSync({ "large.txt": strToU8("small") });
    const view = new DataView(zip.buffer);
    for (let i = 0; i < zip.length - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 21 * 1024 * 1024, true);
    }
    expect(() => readCanvasArchive(zip)).toThrow(/20 MB per file/);
    expect(archiveText({ path: "file.png", bytes: strToU8("not source") })).toBeNull();
    expect(archiveText({ path: "large.txt", bytes: new Uint8Array(512 * 1024 + 1) })).toBeNull();
  });
});

describe("ZIP upload compatibility with draft/deploy limits", () => {
  it("keeps browser upload limits aligned with the authoritative server contract", () => {
    expect(UPLOAD_ARCHIVE_LIMITS).toEqual(LIMITS);
    expect(UPLOAD_ARCHIVE_MAX_BYTES).toBe(LIMITS.maxCanvasBytes + 10 * 1024 * 1024);
  });

  it.each([21, 25])(
    "accepts a %s MiB asset while historical inspection keeps its tighter cap",
    (mebibytes) => {
      const bytes = new Uint8Array(mebibytes * 1024 * 1024);
      bytes[bytes.length - 1] = 123;
      const zip = zipSync({ "asset.bin": bytes }, { level: 1 });
      const files = readUploadArchive(zip);
      expect(files[0]?.bytes.length).toBe(bytes.length);
      expect(files[0]?.bytes[bytes.length - 1]).toBe(123);
      expect(() => readCanvasArchive(zip)).toThrow(/20 MB per file/);
    },
  );

  it("counts 2,000 usable files rather than directory or hidden entries", () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2100; i++) entries[`folder${i}/`] = new Uint8Array();
    for (let i = 0; i < 2000; i++) entries[`folder${i}/page.html`] = strToU8("x");
    entries[".ignored.txt"] = strToU8("ignored");
    const zip = zipSync(entries);
    expect(readUploadArchive(zip)).toHaveLength(2000);
    expect(() => readCanvasArchive(zip)).toThrow(/1,000 files/);
    entries["one-too-many.html"] = strToU8("x");
    expect(() => readUploadArchive(zipSync(entries))).toThrow(/2,000 files/);
  });

  it("rejects oversized declared files and expanded totals before inflation", () => {
    const oversized = zipSync({ "large.bin": strToU8("x") });
    const total = zipSync(
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.bin`, strToU8("x")])),
    );
    for (const [zip, declaredSize] of [
      [oversized, LIMITS.maxFileBytes + 1],
      [total, 21 * 1024 * 1024],
    ] as const) {
      const view = new DataView(zip.buffer);
      for (let i = 0; i < zip.length - 28; i++) {
        if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, declaredSize, true);
      }
      expect(() => readUploadArchive(zip)).toThrow(/25 MB per file and 100 MB total/);
    }
  });
});
