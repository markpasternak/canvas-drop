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
`;
