import { describe, expect, it } from "vitest";
import { emailPreviewDocument } from "../lib/email-preview.js";

describe("local email preview", () => {
  it("substitutes illustrative values and removes executable, remote and navigable content", () => {
    const html = emailPreviewDocument(`<h1>{{teamName}}</h1><p>{{recipientEmail}} {{unknown}}</p>
      <base href="https://tracking.invalid"><meta http-equiv="refresh" content="0;url=https://tracking.invalid">
      <script>fetch('/api/me')</script><iframe src="/admin"></iframe>
      <a href="https://tracking.invalid" ping="https://tracking.invalid" onclick="alert(1)">Open canvas</a>
      <img src="https://tracking.invalid/pixel" srcset="https://tracking.invalid/pixel 2x" onerror="alert(1)">
      <form action="/api/admin/config"><input name="secret"></form>
      <style>p { color: teal }</style>`);
    expect(html).toContain("Example team");
    expect(html).toContain("recipient@example.com");
    expect(html).toContain("Open canvas");
    expect(html).not.toMatch(/tracking.invalid|<script|<iframe|<form|onerror|onclick|{{unknown}}/);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("p { color: teal }");
  });
});
