import { loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { DOC_PAGES } from "./generated-content.js";
import { docsRoutes } from "./routes.js";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_BASE_URL: "https://docs.example.test",
});
const app = () => docsRoutes(config);

describe("docs routes", () => {
  it("serves the social card publicly at /og.png and tags pages with absolute OG meta", async () => {
    const img = await app().request("/og.png");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("max-age");

    const html = await (await app().request("/docs")).text();
    // Absolute image + url (crawlers require absolute), summary_large_image card.
    expect(html).toContain('content="https://docs.example.test/og.png"');
    expect(html).toContain('content="https://docs.example.test/docs"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("GET /docs returns the docs shell", async () => {
    const res = await app().request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("canvas-drop");
    expect(html).toContain('class="toc"'); // left nav present
  });

  it("GET a nested doc page renders content and marks the active nav item", async () => {
    const res = await app().request("/docs/sdk/kv");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Key–value storage");
    expect(html).toContain('href="/docs/sdk/kv" aria-current="page"');
  });

  it("sets the docs CSP, nosniff, and a public cache header", async () => {
    const res = await app().request("/docs");
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'self'; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("max-age");
  });

  it("an unknown doc slug returns the branded 404 (not a 200 shell)", async () => {
    const res = await app().request("/docs/sdk/does-not-exist", {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Page not found");
  });

  it("escapes a reflected unknown slug (no reflected XSS)", async () => {
    const res = await app().request("/docs/%3Cscript%3E", { headers: { accept: "text/html" } });
    expect(res.status).toBe(404);
    const html = await res.text();
    // The malicious path must be reflected URL-encoded + escaped, never as a live tag.
    // (The page legitimately carries the static SYSTEM_THEME_INIT <script>, so assert
    // on the reflected path specifically rather than the absence of any <script>.)
    expect(html).toContain("/docs/%3Cscript%3E");
    expect(html).not.toContain("/docs/<script>");
  });

  it("rejects a non-allow-listed asset name and a missing asset", async () => {
    expect((await app().request("/docs/assets/..%2f..%2fetc")).status).toBe(404);
    expect((await app().request("/docs/assets/evil.js")).status).toBe(404);
    expect((await app().request("/docs/assets/missing.webp")).status).toBe(404);
  });

  it("serves the search client as application/javascript", async () => {
    const res = await app().request("/docs/search.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("has-js");
    expect(js).toContain("No matches.");
    expect(js).toContain("Search unavailable.");
  });

  it("serves the theme client as application/javascript", async () => {
    const res = await app().request("/docs/theme.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    // Shares the dashboard's mechanism: same localStorage key + data-theme attribute.
    expect(js).toContain("canvas-drop-theme");
    expect(js).toContain("data-theme");
  });

  it("serves a search index with one entry per page", async () => {
    const res = await app().request("/docs/search-index.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const idx = (await res.json()) as unknown[];
    expect(idx.length).toBe(DOC_PAGES.length);
  });

  it("serves /llms.txt as public plain text with the SDK + deploy essentials", async () => {
    const res = await app().request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("canvasdrop");
    expect(body).toContain("/v1/canvases/");
  });
});
