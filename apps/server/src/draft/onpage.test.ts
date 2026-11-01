import { describe, expect, it } from "vitest";
import { injectOnPageEditor } from "./onpage.js";

describe("injectOnPageEditor", () => {
  it("inserts the editing shim before </body>", () => {
    const html = "<!doctype html><html><body><h1>hi</h1></body></html>";
    const out = injectOnPageEditor(html);
    expect(out).toContain("data-cd-edit");
    expect(out).toContain("designMode");
    // The shim lands inside the body, before its close tag.
    expect(out.indexOf("data-cd-edit")).toBeLessThan(out.indexOf("</body>"));
    expect(out.indexOf("<h1>hi</h1>")).toBeLessThan(out.indexOf("data-cd-edit"));
  });

  it("appends the shim when there is no </body>", () => {
    const out = injectOnPageEditor("<h1>bare fragment</h1>");
    expect(out.startsWith("<h1>bare fragment</h1>")).toBe(true);
    expect(out).toContain("data-cd-edit");
  });

  it("includes the floating formatting toolbar with the full action set", () => {
    const out = injectOnPageEditor("<body>hi</body>");
    for (const cmd of [
      "bold",
      "italic",
      "underline",
      "strikeThrough",
      "formatBlock",
      "insertUnorderedList",
      "insertOrderedList",
      "createLink",
      "unlink",
      "removeFormat",
    ]) {
      expect(out).toContain(cmd);
    }
    // Injected nodes are stripped from the saved HTML BY REFERENCE (selfScript + bar),
    // never by an attribute query — so a user's own data-* attribute is never deleted.
    expect(out).toContain("document.currentScript");
    expect(out).not.toContain('querySelectorAll("[data-cd-edit]")');
  });

  it("is case-insensitive about the body tag", () => {
    const out = injectOnPageEditor("<HTML><BODY>x</BODY></HTML>");
    expect(out.indexOf("data-cd-edit")).toBeLessThan(out.toLowerCase().indexOf("</body>"));
  });
});

it("posts edits immediately and sends a bounded size warning instead of dropping an oversized edit", async () => {
  const { runInNewContext } = await import("node:vm");
  const listeners = new Map<string, () => void>();
  const posted: Array<{ type: string; html?: string }> = [];
  const element = () => ({
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    style: {},
    parentNode: null,
  });
  const document = {
    readyState: "complete",
    currentScript: element(),
    designMode: "off",
    documentElement: { outerHTML: "<html><body>Edited</body></html>" },
    body: element(),
    createElement: element,
    addEventListener(name: string, handler: () => void) {
      listeners.set(name, handler);
    },
  };
  const script = injectOnPageEditor("")
    .replace(/^<script data-cd-edit>\n/, "")
    .replace(/<\/script>$/, "");
  runInNewContext(script, {
    document,
    parent: {
      postMessage(message: { type: string; html?: string }) {
        posted.push(message);
      },
    },
    window: { addEventListener() {} },
  });
  listeners.get("input")?.();
  expect(posted).toEqual([
    { type: "cd-onpage", html: "<!doctype html>\n<html><body>Edited</body></html>" },
  ]);
  document.documentElement.outerHTML = "x".repeat(2 * 1024 * 1024 + 1);
  listeners.get("input")?.();
  expect(posted[1]).toEqual({ type: "cd-onpage-too-large" });
  expect(listeners.has("message")).toBe(false); // no message echo/save loop
});
