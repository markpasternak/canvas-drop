import { loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { type AccountSummary, accountChooserPage } from "./accounts.js";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "id",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});

const account = (id: string, extra: Partial<AccountSummary> = {}): AccountSummary => ({
  id,
  email: `${id}@example.com`,
  name: null,
  avatarUrl: null,
  ...extra,
});

describe("account chooser page", () => {
  it("leads with the current account when nothing is suggested", () => {
    const html = accountChooserPage({
      config,
      current: account("me"),
      others: [account("a"), account("b")],
    });
    const at = (email: string) => html.indexOf(`Continue as ${email}`);
    expect(at("me@example.com")).toBeLessThan(at("a@example.com"));
    expect(at("a@example.com")).toBeLessThan(at("b@example.com"));
    expect(html).toContain(">Current</span>");
    expect(html).not.toContain("Can open this canvas");
  });

  it("uses the identity provider's photo when it has one (https only), else a tinted initial", () => {
    const html = accountChooserPage({
      config,
      current: account("me", { avatarUrl: "https://img.example/me.png" }),
      others: [account("a", { avatarUrl: "javascript:alert(1)" })],
    });
    expect(html).toContain('<img class="avatar" src="https://img.example/me.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("javascript:");
    expect(html).toMatch(/class="avatar avatar-h" style="--avatar-hue: \d+"/);
  });

  it("says when adding one more account signs out the least recently used one", () => {
    const others = ["a", "b", "c", "d"].map((id) => account(id));
    const html = accountChooserPage({ config, current: account("me"), others, maxAccounts: 5 });
    expect(html).toContain("Adding another signs out d@example.com.");
    expect(html).toContain('aria-describedby="limit-note"');
    const below = accountChooserPage({
      config,
      current: account("me"),
      others: others.slice(0, 3),
      maxAccounts: 5,
    });
    expect(below).not.toContain("limit-note");
  });

  it("escapes names and emails", () => {
    const html = accountChooserPage({
      config,
      current: account("me", { name: "<b>Me</b>" }),
      others: [account("a", { name: '"><script>' })],
    });
    expect(html).not.toContain("<b>Me</b>");
    expect(html).not.toContain('"><script>');
  });
});
