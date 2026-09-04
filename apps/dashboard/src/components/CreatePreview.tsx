const PREVIEW_LIMIT = 250_000;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/** Parse in an inert template: external resources never enter a live document.
 * Strip navigation/active content before serializing into a separate, opaque
 * sandbox. CSP is installed before any supplied markup as a second boundary. */
export function createDocumentPreview(html: string): { document: string; title: string } | null {
  if (!html.trim() || html.length > PREVIEW_LIMIT) return null;
  const template = document.createElement("template");
  template.innerHTML = html;
  const title = template.content.querySelector("title")?.textContent?.trim().slice(0, 200) ?? "";
  for (const node of template.content.querySelectorAll(
    "script,noscript,iframe,frame,frameset,object,embed,link,meta,base,portal,svg,math,template",
  ))
    node.remove();
  for (const node of template.content.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const safeImage =
        name === "src" &&
        node.tagName === "IMG" &&
        /^data:image\/(png|jpeg|gif|webp);base64,/i.test(attribute.value);
      if (
        name.startsWith("on") ||
        name === "autofocus" ||
        [
          "src",
          "srcset",
          "href",
          "xlink:href",
          "action",
          "formaction",
          "background",
          "poster",
          "ping",
        ].includes(name)
      ) {
        if (!safeImage) node.removeAttribute(attribute.name);
      }
    }
  }
  return {
    title,
    document: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body inert>${template.innerHTML}</body></html>`,
  };
}

export function CreatePreview({
  html,
  preview,
}: {
  html: string;
  preview: ReturnType<typeof createDocumentPreview>;
}) {
  return (
    <section className="min-w-0 space-y-2" aria-label="Document preview">
      <p className="text-sm font-medium text-fg">Document preview</p>
      {preview ? (
        <iframe
          title="HTML document preview"
          sandbox=""
          referrerPolicy="no-referrer"
          tabIndex={-1}
          srcDoc={preview.document}
          className="h-72 w-full rounded-lg border border-border bg-white pointer-events-none"
        />
      ) : (
        <div className="grid h-72 place-content-center rounded-lg border border-dashed border-border px-6 text-center text-sm text-muted">
          {html.length > PREVIEW_LIMIT
            ? "This document is too large for an inline preview."
            : "Your page will appear here."}
        </div>
      )}
      <p className="text-xs text-muted">
        Layout only. Scripts, links, and external assets are off. Use the editor’s full preview
        after creating your canvas.
      </p>
    </section>
  );
}
