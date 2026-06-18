import { loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { legalRoutes, renderPrivacyPage, renderTermsPage } from "./legal-pages.js";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_BASE_URL: "https://legal.example.test",
});

describe("legal pages — rendered content", () => {
  it("carries absolute Open Graph + Twitter share tags", () => {
    const html = renderPrivacyPage("https://legal.example.test");
    expect(html).toContain('content="https://legal.example.test/og.png"');
    expect(html).toContain('content="https://legal.example.test/privacy"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('property="og:title" content="Privacy Policy · canvas-drop"');
  });

  it("privacy page states the operator, contact, and the data actually collected", () => {
    const html = renderPrivacyPage();
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("canvas-drop (canvas-drop.com)");
    expect(html).toContain("mark.pasternak@gmail.com");
    // Grounded in what the codebase handles (identity, session cookie, content, logs).
    expect(html).toContain("name, email address, and profile-picture URL");
    expect(html).toContain("essential cookie");
    expect(html).toContain("audit log");
    expect(html).toContain("IP address");
  });

  it("terms page states acceptable use, as-is warranty, and the chosen jurisdiction", () => {
    const html = renderTermsPage();
    expect(html).toContain("Terms of Service");
    expect(html).toContain("Acceptable use");
    expect(html).toContain('"as is"');
    expect(html).toContain("governed by the laws of Sweden");
    expect(html).toContain("mark.pasternak@gmail.com");
  });

  it("both documents cross-link and are pinned to dark (light styles kept for later)", () => {
    for (const html of [renderPrivacyPage(), renderTermsPage()]) {
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
      // Forced dark for now via the html attribute, but the light/dark token styles
      // stay in the page so a future toggle is just an attribute change.
      expect(html).toContain('<html lang="en" data-theme="dark">');
      // The light styles are retained for a future toggle (the media query stays).
      expect(html).toContain("prefers-color-scheme: dark");
    }
  });
});

describe("legal pages — routes are self-contained (no auth context needed)", () => {
  it("GET /privacy returns cacheable, frame-locked HTML", async () => {
    const res = await legalRoutes(config).request("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toContain("max-age");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("GET /terms returns 200 HTML", async () => {
    const res = await legalRoutes(config).request("/terms");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Terms of Service");
  });
});
