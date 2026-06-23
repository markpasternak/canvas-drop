// Pre-paint theme: apply the persisted/param override before first paint so a
// manual dark/light choice never flashes the wrong theme. Light is the default;
// dark otherwise follows prefers-color-scheme via CSS.
(() => {
  try {
    const param = new URLSearchParams(location.search).get("theme");
    const theme =
      param === "light" || param === "dark" ? param : localStorage.getItem("canvas-drop-theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    }

    // Pre-paint design skin: apply the last-known instance skin cached from /api/me.
    // editorial is the base :root, so only alternates set the attribute.
    const skin = localStorage.getItem("canvas-drop-skin");
    if (skin === "studio" || skin === "workshop" || skin === "canvas") {
      document.documentElement.setAttribute("data-skin", skin);
    }
  } catch {
    // Private mode or disabled storage: the app can fall back after React loads.
  }
})();
