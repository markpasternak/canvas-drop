/** A local, inert email mockup. The server still owns the actual template renderer. */
export function emailPreviewDocument(html: string): string {
  const examples: Record<string, string> = {
    recipientEmail: "recipient@example.com",
    name: "Example recipient",
    inviterName: "Example sender",
    canvasTitle: "Example canvas",
    teamName: "Example team",
    link: "https://example.invalid/example",
  };
  // Template contents are inert: parsing does not load remote images or execute scripts.
  const template = document.createElement("template");
  template.innerHTML = html.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => examples[key] ?? "");
  for (const node of template.content.querySelectorAll(
    "script,iframe,object,embed,link,meta,base,form,input,button,video,audio,source,svg,math",
  ))
    node.remove();
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        [
          "href",
          "src",
          "srcset",
          "action",
          "formaction",
          "xlink:href",
          "ping",
          "background",
        ].includes(name)
      )
        element.removeAttribute(attribute.name);
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${template.innerHTML}</body></html>`;
}
