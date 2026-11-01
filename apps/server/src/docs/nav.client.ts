/** Native disclosure remains usable without JS; desktop navigation stays expanded. */
export const NAV_CLIENT_JS = `(() => {
  const menu = document.getElementById("docs-navigation");
  if (!menu) return;
  const summary = menu.querySelector("summary");
  const mobile = matchMedia("(max-width: 48rem)");
  function sync() { menu.open = !mobile.matches; }
  sync();
  mobile.addEventListener("change", sync);
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobile.matches && menu.open) {
      event.preventDefault();
      menu.open = false;
      summary.focus();
    }
  });
})();

(() => {
  document.querySelectorAll(".doc pre:not(.mermaid)").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-command";
    button.textContent = "Copy code";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent || "");
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed — select code";
      }
    });
    pre.before(button);
  });
  document.querySelectorAll(".page-outline a").forEach((link) => {
    link.addEventListener("click", () => {
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      target?.focus({ preventScroll: true });
    });
  });
})();
`;
