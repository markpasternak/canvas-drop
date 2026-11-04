import { describe, expect, it } from "vitest";
import { consentHeaders, redirectFormSource } from "./consent.js";

describe("consent page form-action", () => {
  it("allows the redirect URI's origin, since form-action covers redirect hops", () => {
    expect(redirectFormSource("https://claude.ai/api/mcp/auth_callback")).toBe("https://claude.ai");
    expect(redirectFormSource("http://localhost:33418/callback")).toBe("http://localhost:33418");
    expect(redirectFormSource("http://127.0.0.1:5000/cb")).toBe("http://127.0.0.1:5000");
    expect(redirectFormSource("http://[::1]:5000/cb")).toBe("http://[::1]:5000");
    expect(
      consentHeaders("https://claude.ai/api/mcp/auth_callback")["Content-Security-Policy"],
    ).toBe("frame-ancestors 'none'; form-action 'self' https://claude.ai");
  });

  it("uses the scheme for custom-scheme app callbacks", () => {
    expect(redirectFormSource("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(
      "cursor:",
    );
  });

  it("never lets a redirect URI add extra CSP tokens or directives", () => {
    for (const bad of ["not a url", "https://a.example/x; script-src *", "a b:c"]) {
      const csp = consentHeaders(bad)["Content-Security-Policy"] ?? "";
      expect(csp.split(";").length).toBe(2);
      expect(csp).not.toContain("script-src");
    }
    expect(consentHeaders("not a url")["Content-Security-Policy"]).toBe(
      "frame-ancestors 'none'; form-action 'self'",
    );
  });
});
