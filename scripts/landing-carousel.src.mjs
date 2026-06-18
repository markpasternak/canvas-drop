// Source for the landing product-tour carousel. Bundled to an IIFE at
// docs/site/assets/landing-carousel.js via `pnpm landing:carousel` and served
// same-origin by the docs asset route — the marketing landing has no client
// bundler, so the built file is committed (like the OG card + screenshots).
//
// Standard Embla + the autoplay plugin (slide-by-slide dwell — the right fit for a
// discrete tour, vs auto-scroll's continuous marquee). Embla owns positioning/drag/
// snapping; we only wire the prev/next arrows, the dots, and pause on hover/focus.

import EmblaCarousel from "embla-carousel";
import Autoplay from "embla-carousel-autoplay";

function setup(root) {
  const viewport = root.querySelector("[data-embla-viewport]");
  if (!viewport) return;

  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Autoplay dwells on each slide; it keeps running after arrow/dot use (resets the
  // timer) and pauses while the pointer is over the carousel. Skipped under reduced motion.
  const plugins = reduce
    ? []
    : [Autoplay({ delay: 5200, stopOnInteraction: false, stopOnMouseEnter: true })];

  const embla = EmblaCarousel(viewport, { loop: true, align: "center" }, plugins);

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
