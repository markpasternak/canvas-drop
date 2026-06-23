import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { emailTemplatesRepository } from "../db/repositories/email-templates.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import {
  DEFAULT_TEMPLATES,
  effectiveTemplate,
  PREVIOUS_DEFAULT_TEMPLATES,
  renderTemplate,
  seedDefaultTemplates,
  TEMPLATE_KEYS,
} from "./templates.js";

function previousDefaults(index = 0) {
  const previous = PREVIOUS_DEFAULT_TEMPLATES[index];
  if (!previous) throw new Error("expected previous default templates fixture");
  return previous;
}

describe("renderTemplate (plan 003 phase 3)", () => {
  it("substitutes allow-listed vars; HTML-escapes them in the HTML body, raw in text/subject", () => {
    const body = {
      subject: "Hi {{name}}",
      bodyHtml: "<p>Welcome {{name}} — {{link}}</p>",
      bodyText: "Welcome {{name}} — {{link}}",
    };
    const msg = renderTemplate(body, "u@x.com", { name: "A & B <c>", link: "https://x/y?a=1&b=2" });
    expect(msg.to).toBe("u@x.com");
    expect(msg.subject).toBe("Hi A & B <c>"); // subject is plain text
    // HTML body escapes the value so a name can't inject markup.
    expect(msg.html).toContain("Welcome A &amp; B &lt;c&gt;");
    expect(msg.html).not.toContain("<c>");
    // Text body substitutes raw.
    expect(msg.text).toContain("Welcome A & B <c>");
  });

  it("renders an unknown or absent {{var}} as empty (never throws)", () => {
    const body = { subject: "{{nope}}", bodyHtml: "<p>{{missing}} ok</p>", bodyText: "{{x}} ok" };
    const msg = renderTemplate(body, "u@x.com", {});
    expect(msg.subject).toBe("");
    expect(msg.html).toBe("<p> ok</p>");
    expect(msg.text).toBe(" ok");
  });

  it("substitutes org variables when supplied", () => {
    const body = {
      subject: "{{orgName}}",
      bodyHtml: "<p>{{orgName}}{{orgContext}}</p>",
      bodyText: "{{orgName}}{{orgContext}}",
    };
    const msg = renderTemplate(body, "u@x.com", {
      orgName: "A&B <Org>",
      orgContext: " for A&B <Org>",
    });
    expect(msg.subject).toBe("A&B <Org>");
    expect(msg.html).toContain("A&amp;B &lt;Org&gt;");
    expect(msg.text).toContain("A&B <Org> for A&B <Org>");
  });

  it("a script-bearing value cannot inject executable markup into the HTML body", () => {
    const body = { subject: "s", bodyHtml: "<p>{{name}}</p>", bodyText: "{{name}}" };
    const msg = renderTemplate(body, "u@x.com", { name: "<script>alert(1)</script>" });
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });

  it("seeded defaults avoid instance and org branding in recipient copy", () => {
    for (const template of Object.values(DEFAULT_TEMPLATES)) {
      const combined = `${template.subject}\n${template.bodyHtml}\n${template.bodyText}`;
      expect(combined).not.toContain("{{instanceName}}");
      expect(combined).not.toContain("{{orgName}}");
      expect(combined).not.toContain("{{orgContext}}");
    }
  });
});

describe.each(DIALECTS)("emailTemplates repo + seed (plan 003 phase 3) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("seeds all default keys idempotently; an admin override survives a re-seed; reset restores", async () => {
    client = await makeTestDb(dialect);
    const repo = emailTemplatesRepository(client);

    await seedDefaultTemplates(repo);
    expect((await repo.list()).map((t) => t.key).sort()).toEqual([...TEMPLATE_KEYS].sort());

    // Admin override one template.
    await repo.upsert(
      "team_invite",
      {
        subject: "Custom",
        bodyHtml: "<p>Custom {{teamName}}</p>",
        bodyText: "Custom {{teamName}}",
      },
      "admin-1",
    );
    // A re-seed must NOT clobber the override.
    await seedDefaultTemplates(repo);
    const eff = await effectiveTemplate(repo, "team_invite");
    expect(eff.subject).toBe("Custom");

    // effectiveTemplate falls back to the seeded default for an un-overridden key.
    expect((await effectiveTemplate(repo, "account_invite")).subject).toBe(
      DEFAULT_TEMPLATES.account_invite.subject,
    );

    // Reset restores the default.
    await repo.remove("team_invite");
    expect((await effectiveTemplate(repo, "team_invite")).subject).toBe(
      DEFAULT_TEMPLATES.team_invite.subject,
    );
  });

  it("effectiveTemplate returns the seeded default when no row exists at all (defensive)", async () => {
    client = await makeTestDb(dialect);
    const repo = emailTemplatesRepository(client);
    // No seed run — a missing row must still render via the in-code default.
    expect((await effectiveTemplate(repo, "canvas_invite")).subject).toBe(
      DEFAULT_TEMPLATES.canvas_invite.subject,
    );
  });

  it("updates previous untouched seeded defaults to the latest defaults", async () => {
    client = await makeTestDb(dialect);
    const repo = emailTemplatesRepository(client);
    const previous = previousDefaults();

    await repo.seedDefaults(previous);
    expect((await effectiveTemplate(repo, "canvas_invite")).subject).toBe(
      previous.canvas_invite.subject,
    );

    await seedDefaultTemplates(repo);
    const row = await repo.get("canvas_invite");
    expect(row?.updatedBy).toBeNull();
    expect(row?.subject).toBe(DEFAULT_TEMPLATES.canvas_invite.subject);
  });

  it("updates the just-replaced seeded defaults to the latest defaults", async () => {
    client = await makeTestDb(dialect);
    const repo = emailTemplatesRepository(client);
    const previous = previousDefaults(2);

    await repo.seedDefaults(previous);
    expect((await effectiveTemplate(repo, "team_invite")).subject).toBe(
      previous.team_invite.subject,
    );

    await seedDefaultTemplates(repo);
    const row = await repo.get("team_invite");
    expect(row?.updatedBy).toBeNull();
    expect(row?.subject).toBe(DEFAULT_TEMPLATES.team_invite.subject);
  });

  it("preserves admin-customized rows even when the body matches a previous default", async () => {
    client = await makeTestDb(dialect);
    const repo = emailTemplatesRepository(client);
    const previous = previousDefaults().canvas_invite;

    await repo.upsert("canvas_invite", previous, "admin-1");
    await seedDefaultTemplates(repo);

    const row = await repo.get("canvas_invite");
    expect(row?.updatedBy).toBe("admin-1");
    expect(row?.subject).toBe(previous.subject);
  });
});
