import { describe, expect, it } from "vitest";
import { createDocumentPreview } from "../components/CreatePreview.js";

describe("Create document preview isolation", () => {
  it("removes active content, navigations and external assets before installing a strict CSP", () => {
    const result = createDocumentPreview(
      `<title>My page</title><meta http-equiv="refresh" content="0;url=https://external.invalid"><base href="https://external.invalid"><script>fetch('/api/me')</script><iframe src="https://external.invalid"></iframe><link rel="stylesheet" href="https://external.invalid/style.css"><img src="https://external.invalid/pixel" onerror="alert(1)"><a href="https://external.invalid" ping="https://external.invalid">Click</a><form action="https://external.invalid"><input autofocus><button formaction="https://external.invalid">Go</button></form><svg><a href="https://external.invalid">SVG</a></svg><template><iframe src="https://external.invalid"></iframe></template><style>h1 { color: red }</style><h1>Welcome</h1>`,
    );
    expect(result?.title).toBe("My page");
    expect(result?.document).toContain("default-src 'none'");
    expect(result?.document).toContain("form-action 'none'");
    expect(result?.document).toContain("<body inert>");
    expect(result?.document).toContain("h1 { color: red }");
    expect(result?.document).not.toMatch(
      /external\.invalid|onerror|autofocus|<script|<iframe|<svg|<template|http-equiv="refresh"/,
    );
    expect(result?.document.indexOf("Content-Security-Policy")).toBeLessThan(
      result?.document.indexOf("Welcome") ?? -1,
    );
  });

  it("keeps embedded raster images but omits empty or oversized previews", () => {
    expect(createDocumentPreview('<img src="data:image/png;base64,AA==">')?.document).toContain(
      'src="data:image/png;base64,AA=="',
    );
    expect(createDocumentPreview("  ")).toBeNull();
    expect(createDocumentPreview("a".repeat(250_001))).toBeNull();
  });
});
