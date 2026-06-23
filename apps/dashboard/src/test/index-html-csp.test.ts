import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, "../..");

describe("dashboard shell CSP compatibility", () => {
  it("keeps pre-paint bootstrap external so script-src 'self' can stay strict", async () => {
    const html = await readFile(resolve(dashboardRoot, "index.html"), "utf8");
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1] ?? "");

    expect(html).toContain('<script src="/dashboard-bootstrap.js"></script>');
    expect(scriptTags.filter((attrs) => !/\bsrc=/.test(attrs))).toEqual([]);
  });
});
