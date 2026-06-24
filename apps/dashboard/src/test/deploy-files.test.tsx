import { describe, expect, it } from "vitest";
import { canvasRelativePaths } from "../components/DeployFiles.js";

function makeFile(name: string, opts: { path?: string; webkitRelativePath?: string } = {}): File {
  const file = new File(["x"], name);
  if (opts.path !== undefined) {
    Object.defineProperty(file, "path", { value: opts.path, configurable: true });
  }
  if (opts.webkitRelativePath !== undefined) {
    Object.defineProperty(file, "webkitRelativePath", {
      value: opts.webkitRelativePath,
      configurable: true,
    });
  }
  return file;
}

describe("canvasRelativePaths", () => {
  it("strips a single shared wrapper folder so its contents land at the canvas root", () => {
    const files = [
      makeFile("index.html", { path: "/site/index.html" }),
      makeFile("a.css", { path: "/site/assets/a.css" }),
    ];
    expect(canvasRelativePaths(files)).toEqual(["index.html", "assets/a.css"]);
  });

  it("keeps webkitdirectory paths (shared top folder) and lands them at root", () => {
    const files = [
      makeFile("index.html", { webkitRelativePath: "myfolder/index.html" }),
      makeFile("b.js", { webkitRelativePath: "myfolder/sub/b.js" }),
    ];
    expect(canvasRelativePaths(files)).toEqual(["index.html", "sub/b.js"]);
  });

  it("does NOT strip when a file is dropped alongside a folder (no shared wrapper)", () => {
    // The reported bug: dropping a top-level index.html together with assets/ and a
    // nested folder must NOT flatten the folders (that lost the `assets/` prefix and
    // collided the two index.html files onto one).
    const files = [
      makeFile("index.html", { path: "/index.html" }),
      makeFile("logo.webp", { path: "/assets/logo.webp" }),
      makeFile("index.html", { path: "/scrubbed-deploy/index.html" }),
    ];
    expect(canvasRelativePaths(files)).toEqual([
      "index.html",
      "assets/logo.webp",
      "scrubbed-deploy/index.html",
    ]);
  });

  it("does NOT strip when several folders are dropped together (differing top segments)", () => {
    const files = [
      makeFile("a.css", { path: "/css/a.css" }),
      makeFile("b.js", { path: "/js/b.js" }),
    ];
    expect(canvasRelativePaths(files)).toEqual(["css/a.css", "js/b.js"]);
  });

  it("strips leading slashes and falls back to name when no path metadata is present", () => {
    expect(canvasRelativePaths([makeFile("bare.css")])).toEqual(["bare.css"]);
  });
});
