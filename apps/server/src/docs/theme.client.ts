/**
 * The docs theme client, served verbatim at GET /docs/theme.js as
 * `application/javascript`, and loaded from the <head> so it runs before first
 * paint (no flash). It is a plain browser script (no bundler) so the docs CSP
 * can stay `script-src 'self'` with no nonce.
 *
 * It shares the dashboard's theme mechanism exactly (see apps/dashboard/src/lib/
 * theme.tsx): the `data-theme` attribute on <html> and the `canvas-drop-theme`
 * localStorage key, so a theme chosen in the app carries into the docs and back.
 * A `?theme=light|dark` query param wins for the initial paint (shareable themed
 * links), matching the dashboard. The topbar switch (System / Light / Dark) is
 * wired once the DOM is ready.
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
  const initial = param === "light" || param === "dark" ? param : stored();
  apply(initial);

  function wire() {
    const group = document.querySelector("[data-theme-switch]");
    if (!group) return;
    const buttons = group.querySelectorAll("button[data-theme-choice]");

    function sync(choice) {
      buttons.forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.themeChoice === choice));
      });
    }

    sync(initial);
    buttons.forEach((b) => {
      b.addEventListener("click", () => {
        const choice = b.dataset.themeChoice;
        apply(choice);
        try {
          if (choice === "system") localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, choice);
        } catch {
          /* private mode — non-fatal */
        }
        sync(choice);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
`;
