/**
 * On-page text editing (M5 polish): when the draft preview is requested with
 * `?edit=1` and the entry is an HTML page, the server injects a small shim that
 * makes the rendered page editable (`document.designMode`) and posts the cleaned
 * HTML back to the dashboard on each edit. The dashboard writes it to the single
 * HTML file in the draft. The shim is OUR static script (no user input), runs in
 * the sandboxed (opaque-origin) preview iframe, and is stripped from the serialized
 * HTML before saving so it never persists.
 *
 * Scope: only meaningful for a static single-HTML page — text in the HTML source.
 * For JS-rendered SPAs the visible text isn't in any file, so the dashboard only
 * offers this mode when the draft is exactly one HTML file.
 */
const ON_PAGE_SHIM = `<script data-cd-edit>
(function () {
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  ready(function () {
    try { document.designMode = "on"; } catch (e) {}
    var timer;
    function serialize() {
      var root = document.documentElement.cloneNode(true);
      var injected = root.querySelectorAll("[data-cd-edit]");
      for (var i = 0; i < injected.length; i++) injected[i].remove();
      return "<!doctype html>\\n" + root.outerHTML;
    }
    document.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        parent.postMessage({ type: "cd-onpage", html: serialize() }, "*");
      }, 600);
    });
  });
})();
</script>`;

/** Insert the on-page editing shim before </body> (or append when there's none). */
export function injectOnPageEditor(html: string): string {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html + ON_PAGE_SHIM;
  return html.slice(0, idx) + ON_PAGE_SHIM + html.slice(idx);
}
