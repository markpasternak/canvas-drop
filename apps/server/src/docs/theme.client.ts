/**
 * The public-site theme client, served verbatim at GET /docs/theme.js as
 * `application/javascript`, and loaded from the <head> so it runs before first
 * paint (no flash). It is a plain browser script (no bundler) so the docs CSP
 * can stay `script-src 'self'` with no nonce.
 *
 * It shares the dashboard's theme mechanism exactly (see apps/dashboard/src/lib/
 * theme.tsx): the `data-theme` attribute on <html> and the `canvas-drop-theme`
 * localStorage key, so a theme chosen in the app carries into docs, legal and marketing pages.
 * A `?theme=light|dark` query param wins for the initial paint (shareable themed
 * links), matching the dashboard. Delegated controls work as soon as the header
 * is parsed, without waiting for deferred scripts to finish downloading.
 */
export const THEME_CLIENT_JS = `(() => {
  const KEY = "canvas-drop-theme";

  function stored() {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  }

  function apply(choice) {
    const el = document.documentElement;
    if (choice === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", choice);
  }

  // A \`?theme=light|dark\` query param wins for the initial paint; otherwise the
  // persisted manual choice; otherwise follow the OS (no attribute).
  const param = new URLSearchParams(location.search).get("theme");
  let choice = param === "light" || param === "dark" ? param : stored();
  apply(choice);
  document.documentElement.classList.add("theme-ready");

  function sync() {
    const group = document.querySelector("[data-theme-switch]");
    if (!group) return;
    group.querySelectorAll("button[data-theme-choice]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-theme-switch] button[data-theme-choice]");
    if (!button) return;
    const next = button.dataset.themeChoice;
    if (next !== "system" && next !== "light" && next !== "dark") return;
    choice = next;
    apply(choice);
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      /* private mode — non-fatal */
    }
    sync();
  });

  // Interactive fires before deferred bundles complete. Keep the current choice
  // if a visitor has already used the switch while the document was parsing.
  if (document.readyState === "loading") {
    document.addEventListener("readystatechange", sync);
  }
  sync();
})();
`;
