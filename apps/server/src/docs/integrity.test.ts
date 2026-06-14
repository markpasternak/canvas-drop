import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES } from "@canvas-drop/sdk";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { DOC_PAGES } from "./generated-content.js";
import { hasDocPage } from "./render.js";
import { docsRoutes } from "./routes.js";

const allHtml = DOC_PAGES.map((p) => p.html).join("\n");
const allText = DOC_PAGES.map((p) => `${p.title}\n${p.text}`).join("\n");

describe("docs integrity", () => {
  it("serves /skill.zip containing ONLY allow-listed markdown (no secrets)", async () => {
    const res = await docsRoutes().request("/skill.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    const entries = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(entries).toContain("canvas-drop/SKILL.md");
    // Canary: every entry is a .md file; nothing that looks like a secret leaks.
    for (const name of entries) {
      expect(name.endsWith(".md"), `unexpected zip entry: ${name}`).toBe(true);
      expect(/\.env|secret|\bkey\b/i.test(name), `suspicious zip entry: ${name}`).toBe(false);
    }
  });

  it("is org-agnostic — no page hardcodes an instance domain (R11)", () => {
    // Product/package name 'canvas-drop' is fine; a baked instance domain is not.
    expect(allText).not.toContain("canvas-drop.com");
    expect(allHtml).not.toContain("canvas-drop.com");
  });

  it("has no dead internal /docs links", () => {
    const links = new Set<string>();
    for (const m of allHtml.matchAll(/href="\/docs(?:\/([^"#]*))?(?:#[^"]*)?"/g)) {
      links.add(m[1] ?? ""); // "" === the /docs index
    }
    for (const path of links) {
      expect(hasDocPage(path), `dead docs link: /docs/${path}`).toBe(true);
    }
  });

  it("documents every SDK error code (drift guard)", () => {
    const errorsPage = DOC_PAGES.find((p) => p.path === "api/errors");
    expect(errorsPage).toBeTruthy();
    for (const code of Object.keys(ERROR_CODES)) {
      expect(errorsPage?.html.includes(code), `missing error code in docs: ${code}`).toBe(true);
    }
  });

  it("references only real config env vars", () => {
    const env = readFileSync(join(process.cwd(), "packages/shared/src/config/env.ts"), "utf8");
    const names = new Set<string>();
    for (const m of allText.matchAll(/CANVAS_DROP_[A-Z0-9_]+/g)) {
      names.add(m[0].replace(/_+$/, "")); // strip trailing _ from wildcard forms (S3_*)
    }
    expect(names.size).toBeGreaterThan(5);
    for (const name of names) {
      expect(env.includes(name), `docs reference an unknown config var: ${name}`).toBe(true);
    }
  });
});
