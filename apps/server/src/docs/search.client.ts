/**
 * The docs search client, served verbatim at GET /docs/search.js as
 * `application/javascript`. It is a plain browser script (no bundler) so the
 * docs CSP can stay `script-src 'self'` with no nonce. It marks the document
 * JS-capable (revealing the search box, hidden by default for the no-JS path),
 * lazily fetches the search index on first focus, and renders a results dropdown
 * with explicit empty / no-result / failure states.
 */
export const SEARCH_CLIENT_JS = `(() => {
  document.documentElement.classList.add("has-js");
  const input = document.getElementById("docs-search");
  const out = document.getElementById("docs-search-results");
  if (!input || !out) return;

  let index = null;
  let loadFailed = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  async function ensureIndex() {
    if (index || loadFailed) return;
    try {
      const res = await fetch("/docs/search-index.json", { credentials: "omit" });
      if (!res.ok) throw new Error("bad status");
      index = await res.json();
    } catch {
      loadFailed = true;
    }
  }

  function hrefFor(path) {
    return path === "" ? "/docs" : "/docs/" + path;
  }

  function render(q) {
    const query = q.trim().toLowerCase();
    if (!query) {
      out.innerHTML = "";
      return;
    }
    if (loadFailed) {
      out.innerHTML = '<span class="empty">Search unavailable.</span>';
      return;
    }
    if (!index) return;
    const hits = [];
    for (const e of index) {
      const hay = (e.title + " " + e.headings.join(" ") + " " + e.text).toLowerCase();
      if (hay.includes(query)) hits.push(e);
      if (hits.length >= 12) break;
    }
    if (!hits.length) {
      out.innerHTML = '<span class="empty">No matches.</span>';
      return;
    }
    out.innerHTML = hits
      .map((e) => '<a href="' + hrefFor(e.path) + '">' + esc(e.title) + "</a>")
      .join("");
  }

  input.addEventListener("focus", ensureIndex, { once: true });
  input.addEventListener("input", async () => {
    await ensureIndex();
    render(input.value);
  });
  input.addEventListener("blur", () => {
    // Delay so a click on a result registers before the dropdown clears.
    setTimeout(() => {
      out.innerHTML = "";
    }, 150);
  });
})();
`;
