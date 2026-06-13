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
