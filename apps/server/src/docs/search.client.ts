/** Public, same-origin enhancement: ranked search with native links and retry. */
export const SEARCH_CLIENT_JS = `(() => {
  document.documentElement.classList.add("has-js");
  const input = document.getElementById("docs-search");
  const out = document.getElementById("docs-search-results");
  if (!input || !out) return;
  const search = input.closest(".search");
  let index = null;
  let loading = null;
  let generation = 0;
  let pending = false;

  function dismiss() {
    generation++;
    pending = false;
    out.innerHTML = "";
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }
  async function ensureIndex() {
    if (index) return index;
    if (!loading) loading = (async () => {
      const res = await fetch("/docs/search-index.json", { credentials: "omit" });
      if (!res.ok) throw new Error("bad status");
      const entries = await res.json();
      if (!Array.isArray(entries)) throw new Error("bad index");
      index = entries;
      return index;
    })().finally(() => { loading = null; });
    return loading;
  }
  function hrefFor(path) { return path === "" ? "/docs" : "/docs/" + path; }
  function match(entry, query) {
    const title = entry.title.toLowerCase();
    const heading = entry.headings.find((h) => h.toLowerCase().includes(query));
    const pos = entry.text.toLowerCase().indexOf(query);
    const score = title === query ? 4 : title.includes(query) ? 3 : heading ? 2 : pos >= 0 ? 1 : 0;
    const start = Math.max(0, pos - 48);
    const context = heading || (start ? "…" : "") + entry.text.slice(start, start + 150).trim() + (entry.text.length > start + 150 ? "…" : "");
    return { entry, score, context };
  }
  function render(query) {
    const hits = index.map((e) => match(e, query)).filter((h) => h.score)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
    if (!hits.length) {
      out.innerHTML = '<p class="empty" role="status">No matching pages. Try another term.</p>';
      return;
    }
    const count = hits.length + (hits.length === 1 ? " page" : " pages") + (hits.length > 12 ? "; showing the 12 best matches" : "");
    out.innerHTML = '<p class="search-count" role="status">' + count + '</p>' + hits.slice(0, 12)
      .map(({ entry, context }) => '<a href="' + esc(hrefFor(entry.path)) + '"><strong>' + esc(entry.title) + '</strong><span>' + esc(context) + '</span></a>').join("");
  }
  async function run() {
    const query = input.value.trim().toLowerCase();
    const current = ++generation;
    if (!query) { pending = false; out.innerHTML = ""; return; }
    pending = true;
    out.innerHTML = '<p class="empty" role="status">Searching documentation…</p>';
    try {
      await ensureIndex();
      if (current !== generation) return;
      pending = false;
      if (search.contains(document.activeElement)) render(query);
    } catch {
      if (current !== generation) return;
      pending = false;
      out.innerHTML = '<p class="empty" role="alert">Search unavailable.</p><button type="button" data-search-retry>Retry search</button>';
    }
  }
  input.addEventListener("focus", () => { ensureIndex().catch(() => {}); });
  input.addEventListener("input", run);
  out.addEventListener("click", (event) => {
    if (event.target.closest("[data-search-retry]")) { input.focus(); run(); }
  });
  search.addEventListener("focusout", (event) => {
    // Safari can blur without focusing a clicked result; leave it mounted for activation.
    if (event.relatedTarget && !search.contains(event.relatedTarget)) dismiss();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!search.contains(event.target)) dismiss();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (pending || out.childElementCount)) {
      event.preventDefault(); event.stopPropagation(); dismiss(); input.focus(); return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = Array.from(out.querySelectorAll("a"));
    if (!links.length) return;
    event.preventDefault();
    const at = links.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (at + 1) % links.length : (at < 0 ? links.length - 1 : (at - 1 + links.length) % links.length);
    links[next].focus();
  });
})();
`;
