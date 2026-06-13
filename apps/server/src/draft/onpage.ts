/**
 * On-page text editing (M5 polish): when the draft preview is requested with
 * `?edit=1` and the entry is an HTML page, the server injects a small shim that
 * makes the rendered page editable (`document.designMode`), shows a floating
 * formatting toolbar on selection, and posts the cleaned HTML back to the dashboard
 * on each edit. The dashboard writes it to the single HTML file in the draft.
 *
 * The shim is OUR static script (no user input), runs in the sandboxed
 * (opaque-origin) preview iframe, and everything it injects is tagged
 * `data-cd-edit` so it's stripped from the serialized HTML and never persists.
 *
 * Scope: only meaningful for a static single-HTML page — text in the HTML source.
 * For JS-rendered SPAs the visible text isn't in any file, so the dashboard only
 * offers this mode when the draft is exactly one HTML file.
 *
 * `document.execCommand` is deprecated but universally supported; it's the pragmatic
 * mechanism for a lightweight inline-formatting toolbar.
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
    function save() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        parent.postMessage({ type: "cd-onpage", html: serialize() }, "*");
      }, 400);
    }
    document.addEventListener("input", save);

    // Floating formatting toolbar (data-cd-edit → excluded from saved HTML).
    var bar = document.createElement("div");
    bar.setAttribute("data-cd-edit", "");
    bar.setAttribute("contenteditable", "false");
    bar.style.cssText =
      "position:fixed;z-index:2147483647;display:none;gap:2px;padding:4px;border-radius:8px;" +
      "background:#1a1a1e;box-shadow:0 6px 20px rgba(0,0,0,.28);font:13px system-ui,sans-serif;";
    // ["|"] renders a divider; otherwise [label, command, value|null, buttonStyle].
    var actions = [
      ["B", "bold", null, "font-weight:700"],
      ["I", "italic", null, "font-style:italic"],
      ["U", "underline", null, "text-decoration:underline"],
      ["S", "strikeThrough", null, "text-decoration:line-through"],
      ["|"],
      ["H1", "formatBlock", "h1", ""],
      ["H2", "formatBlock", "h2", ""],
      ["Body", "formatBlock", "p", ""],
      ["Quote", "formatBlock", "blockquote", ""],
      ["|"],
      ["List", "insertUnorderedList", null, ""],
      ["1.List", "insertOrderedList", null, ""],
      ["|"],
      ["Link", "__link", null, ""],
      ["Unlink", "unlink", null, ""],
      ["Clear", "removeFormat", null, ""],
    ];
    actions.forEach(function (a) {
      if (a[0] === "|") {
        var sep = document.createElement("span");
        sep.style.cssText = "width:1px;align-self:stretch;margin:2px 2px;background:rgba(255,255,255,.16)";
        bar.appendChild(sep);
        return;
      }
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = a[0];
      b.style.cssText =
        "all:unset;cursor:pointer;color:#fff;padding:4px 8px;border-radius:5px;white-space:nowrap;" +
        (a[3] || "");
      b.addEventListener("mouseenter", function () { b.style.background = "rgba(255,255,255,.14)"; });
      b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
      b.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep the selection
      b.addEventListener("click", function (e) {
        e.preventDefault();
        if (a[1] === "__link") {
          var url = prompt("Link URL (https://...)");
          if (url) document.execCommand("createLink", false, url);
        } else if (a[2]) {
          document.execCommand(a[1], false, a[2]);
        } else {
          document.execCommand(a[1], false);
        }
        save();
        position();
      });
      bar.appendChild(b);
    });
    document.body.appendChild(bar);

    function position() {
      var sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { bar.style.display = "none"; return; }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { bar.style.display = "none"; return; }
      bar.style.display = "flex";
      var top = rect.top - bar.offsetHeight - 8;
      if (top < 8) top = rect.bottom + 8;
      var left = rect.left + rect.width / 2 - bar.offsetWidth / 2;
      var maxLeft = window.innerWidth - bar.offsetWidth - 8;
      if (left > maxLeft) left = maxLeft;
      if (left < 8) left = 8;
      bar.style.top = top + "px";
      bar.style.left = left + "px";
    }
    document.addEventListener("selectionchange", position);
    window.addEventListener("scroll", position, true);
  });
})();
</script>`;

/** Insert the on-page editing shim before </body> (or append when there's none). */
export function injectOnPageEditor(html: string): string {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html + ON_PAGE_SHIM;
  return html.slice(0, idx) + ON_PAGE_SHIM + html.slice(idx);
}
