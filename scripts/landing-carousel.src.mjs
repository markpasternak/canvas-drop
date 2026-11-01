// Manual product tour. The committed bundle is served from the same origin.
// Embla owns positioning and dragging; without JavaScript, native scroll-snap
// keeps every screenshot, caption, and full-size link available.
import EmblaCarousel from "embla-carousel";

// A select-only combobox keeps focus on one trigger while aria-activedescendant
// names the highlighted option. Opening never changes the chosen slide.
function setupTopicPicker(root, select, onSelect) {
  const picker = root.querySelector("[data-tour-picker]");
  const trigger = root.querySelector("[data-tour-trigger]");
  const value = root.querySelector("[data-tour-value]");
  const list = root.querySelector("[data-tour-list]");
  const options = Array.from(root.querySelectorAll("[data-tour-option]"));
  if (!select || !picker || !trigger || !value || !list || !options.length) return null;

  let open = false;
  let selected = Number(select.value) || 0;
  let active = selected;
  let search = "";
  let lastTyped = 0;

  function position() {
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    const flip = below < Math.min(320, options.length * 44 + 12) && above > below;
    list.setAttribute("data-side", flip ? "above" : "below");
    list.style.maxHeight = `${Math.max(44, Math.min(320, (flip ? above : below) - 16))}px`;
  }

  function highlight(index) {
    active = Math.max(0, Math.min(options.length - 1, index));
    options.forEach((option, i) => {
      option.setAttribute("data-active", String(i === active));
    });
    if (!open) return;
    const option = options[active];
    trigger.setAttribute("aria-activedescendant", option.id);
    // Scroll only the popup, never the document containing the product tour.
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }

  function close(returnFocus = false) {
    if (!open) return;
    open = false;
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    search = "";
    if (returnFocus) trigger.focus({ preventScroll: true });
  }

  function show(index = selected) {
    open = true;
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    position();
    highlight(index);
  }

  function choose(index) {
    onSelect(index);
    close(true);
  }

  function typeahead(key) {
    const now = Date.now();
    search = now - lastTyped > 700 ? key : search + key;
    lastTyped = now;
    // Repeating a letter cycles matching topics, as a native select does.
    const query = [...search].every((letter) => letter === search[0]) ? search[0] : search;
    const start = query.length === 1 ? active + 1 : active;
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + offset) % options.length;
      if (options[index].textContent.trim().toLocaleLowerCase().startsWith(query)) {
        highlight(index);
        break;
      }
    }
  }

  trigger.addEventListener("click", () => (open ? close() : show()));
  trigger.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      if (!open) return;
      close(true);
    } else if (event.key === "Tab") {
      close();
      return; // Normal focus movement, with no trapping and no implicit selection.
    } else if (event.key === "Enter" || event.key === " ") {
      if (open) choose(active);
      else show();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open) show();
      else highlight(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      show(event.key === "Home" ? 0 : options.length - 1);
    } else if (event.key.length === 1) {
      if (!open) show();
      typeahead(event.key.toLocaleLowerCase());
    } else return;
    event.preventDefault();
  });
  options.forEach((option, index) => {
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => choose(index));
  });
  document.addEventListener("pointerdown", (event) => {
    if (open && !picker.contains(event.target)) close();
  });
  document.addEventListener("focusin", (event) => {
    if (open && !picker.contains(event.target)) close();
  });
  window.addEventListener("resize", () => {
    if (open) position();
  });

  // Keep the real select as a working fallback until the custom control is ready.
  picker.hidden = false;
  select.hidden = true;
  return {
    update(index) {
      selected = index;
      value.textContent = options[index].textContent.trim();
      options.forEach((option, i) => {
        option.setAttribute("aria-selected", String(i === index));
      });
      if (!open) active = selected;
    },
  };
}

function setup(root) {
  const viewport = root.querySelector("[data-embla-viewport]");
  if (!viewport) return;

  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  root.classList.add("is-enhanced");
  let embla;
  try {
    embla = EmblaCarousel(viewport, {
      loop: true,
      align: "center",
      duration: motion?.matches ? 0 : 20,
    });
  } catch {
    // A failed enhancement must leave the native scrolling tour usable.
    root.classList.remove("is-enhanced");
    return;
  }

  const select = root.querySelector("[data-embla-select]");
  const count = root.querySelector("[data-embla-count]");
  const slides = embla.slideNodes();
  const picker = setupTopicPicker(root, select, (index) => embla.scrollTo(index));
  root.querySelector("[data-embla-controls]")?.removeAttribute("hidden");
  const instructions = root.querySelector("[data-embla-instructions]");
  if (instructions) instructions.textContent = "Choose a topic, use the arrows, or swipe.";

  root.querySelector("[data-embla-prev]")?.addEventListener("click", () => embla.scrollPrev());
  root.querySelector("[data-embla-next]")?.addEventListener("click", () => embla.scrollNext());
  select?.addEventListener("change", () => {
    const index = Number(select.value);
    if (Number.isInteger(index) && index >= 0 && index < slides.length) embla.scrollTo(index);
  });

  // Only the focused viewport owns these keys. Selects and links keep their
  // normal keyboard behavior; this is never a page-wide shortcut.
  viewport.addEventListener("keydown", (event) => {
    if (event.target !== viewport || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft") embla.scrollPrev();
    else if (event.key === "ArrowRight") embla.scrollNext();
    else if (event.key === "Home") embla.scrollTo(0);
    else if (event.key === "End") embla.scrollTo(slides.length - 1);
    else return;
    event.preventDefault();
  });

  function update() {
    const selected = embla.selectedScrollSnap();
    if (select) select.value = String(selected);
    picker?.update(selected);
    if (count) count.textContent = `${selected + 1} / ${slides.length}`;
    slides.forEach((slide, index) => {
      const inactive = index !== selected;
      slide.inert = inactive;
      slide.setAttribute("aria-hidden", String(inactive));
    });
  }

  motion?.addEventListener("change", () => embla.reInit({ duration: motion.matches ? 0 : 20 }));
  embla.on("select", update).on("init", update).on("reInit", update);
  update();
}

function init() {
  document.querySelectorAll("[data-embla]").forEach(setup);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
