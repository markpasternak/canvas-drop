// Source for the landing product-tour carousel. Bundled to an IIFE at
// docs/site/assets/landing-carousel.js via `pnpm landing:carousel` and served
// same-origin by the docs asset route — the marketing landing has no client
// bundler, so the built file is committed (like the OG card + screenshots).
//
// Embla owns positioning and dragging. Navigation is manual so the selected
// screen stays available for reading. Without JavaScript, scroll-snap is native.

import EmblaCarousel from "embla-carousel";

function setup(root) {
  const viewport = root.querySelector("[data-embla-viewport]");
  if (!viewport) return;

  // Stay on the view the visitor chooses. Without JS the viewport scrolls natively.
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  root.classList.add("is-enhanced");
  const embla = EmblaCarousel(viewport, { loop: true, align: "center", duration: reduce ? 0 : 25 });
  root.querySelector("[data-embla-controls]")?.removeAttribute("hidden");

  const prev = root.querySelector("[data-embla-prev]");
  const next = root.querySelector("[data-embla-next]");
  const dots = Array.prototype.slice.call(root.querySelectorAll("[data-embla-dot]"));

  if (prev) prev.addEventListener("click", () => embla.scrollPrev());
  if (next) next.addEventListener("click", () => embla.scrollNext());
  dots.forEach((dot, i) => {
    dot.addEventListener("click", () => embla.scrollTo(i));
  });

  function update() {
    const selected = embla.selectedScrollSnap();
    dots.forEach((d, i) => {
      d.setAttribute("aria-current", i === selected ? "true" : "false");
    });
  }

  embla.on("select", update).on("init", update).on("reInit", update);
  update();
}

function init() {
  document.querySelectorAll("[data-embla]").forEach(setup);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
