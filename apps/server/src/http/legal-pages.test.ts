import { describe, expect, it } from "vitest";
import { legalRoutes, renderPrivacyPage, renderTermsPage } from "./legal-pages.js";

describe("legal pages — rendered content", () => {
  it("privacy page states the operator, contact, and the data actually collected", () => {
    const html = renderPrivacyPage();
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Canvasdrop (canvas-drop.com)");
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

  it("both documents cross-link and are light-mode only (no dark-scheme block)", () => {
    for (const html of [renderPrivacyPage(), renderTermsPage()]) {
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
      // Light-mode only per the design brief: no dark-scheme media query.
      expect(html).not.toContain("prefers-color-scheme: dark");
      expect(html).not.toContain("color-scheme: light dark");
    }
  });
});

describe("legal pages — routes are self-contained (no auth context needed)", () => {
  it("GET /privacy returns cacheable, frame-locked HTML", async () => {
    const res = await legalRoutes().request("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toContain("max-age");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("GET /terms returns 200 HTML", async () => {
    const res = await legalRoutes().request("/terms");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Terms of Service");
  });
});
