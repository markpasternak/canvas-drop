import { describe, expect, it } from "vitest";
import { canvasRelativePath } from "../components/DeployFiles.js";

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

describe("canvasRelativePath", () => {
  it("strips leading slash and top folder segment from path", () => {
    const file = makeFile("a.html", { path: "/folder/sub/a.html" });
    expect(canvasRelativePath(file)).toBe("sub/a.html");
  });

  it("strips leading slash when there's no subfolder (top-level file)", () => {
    const file = makeFile("index.html", { path: "/folder/index.html" });
    expect(canvasRelativePath(file)).toBe("index.html");
  });

  it("falls back to webkitRelativePath when path is absent", () => {
    const file = makeFile("b.js", { webkitRelativePath: "myfolder/b.js" });
    expect(canvasRelativePath(file)).toBe("b.js");
  });

  it("falls back to name when neither path nor webkitRelativePath is set", () => {
    const file = makeFile("bare.css");
    expect(canvasRelativePath(file)).toBe("bare.css");
  });
});
