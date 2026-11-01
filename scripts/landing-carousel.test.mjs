import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const controller = readFileSync(
  new URL("./landing-carousel.src.mjs", import.meta.url),
  "utf8",
).replace(/^import EmblaCarousel from "embla-carousel";$/m, "");

function element() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    value: "0",
    textContent: "",
    inert: false,
    hidden: false,
    style: {},
    scrollTop: 0,
    clientHeight: 320,
    offsetTop: 0,
    offsetHeight: 44,
    focus: vi.fn(),
    getBoundingClientRect: () => ({ top: 300, bottom: 344 }),
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
    getAttribute: (key) => attributes.get(key),
    addEventListener: (type, callback) => listeners.set(type, callback),
    emit(type, event = {}) {
      listeners.get(type)?.(event);
    },
  };
}

function mount({ reduced = false, fail = false, missingPicker = false } = {}) {
  const nodes = Object.fromEntries(
    [
      "viewport",
      "select",
      "count",
      "controls",
      "instructions",
      "prev",
      "next",
      "picker",
      "trigger",
      "value",
      "list",
    ].map((name) => [name, element()]),
  );
  nodes.controls.setAttribute("hidden", "");
  nodes.picker.hidden = true;
  nodes.list.hidden = true;
  const options = ["Your workspace", "Edit & publish", "Gallery & templates"].map(
    (label, index) => ({
      ...element(),
      id: `tour-topic-${index}`,
      textContent: label,
      offsetTop: index * 44,
    }),
  );
  nodes.picker.contains = (target) =>
    [nodes.picker, nodes.trigger, nodes.list, nodes.value, ...options].includes(target);
  const slides = Array.from({ length: 3 }, element);
  const classes = new Set();
  const root = {
    querySelector: (selector) => {
      const name = selector.replace(/^\[data-(embla|tour)-|\]$/g, "");
      return missingPicker && name === "picker" ? null : nodes[name];
    },
    querySelectorAll: () => options,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
  };
  const callbacks = new Map();
  let selected = 0;
  function goTo(index) {
    selected = index;
    callbacks.get("select")?.();
  }
  const embla = {
    slideNodes: () => slides,
    selectedScrollSnap: () => selected,
    scrollPrev: vi.fn(() => goTo((selected + 2) % 3)),
    scrollNext: vi.fn(() => goTo((selected + 1) % 3)),
    scrollTo: vi.fn(goTo),
    reInit: vi.fn(() => callbacks.get("reInit")?.()),
    on: (event, callback) => {
      callbacks.set(event, callback);
      return embla;
    },
  };
  const factory = vi.fn(() => {
    if (fail) throw new Error("Enhancement unavailable");
    return embla;
  });
  const motion = { ...element(), matches: reduced };
  const doc = { ...element(), readyState: "complete", querySelectorAll: () => [root] };
  const win = { ...element(), innerHeight: 800, matchMedia: () => motion };
  runInNewContext(controller, { EmblaCarousel: factory, document: doc, window: win });
  return { nodes, slides, classes, embla, factory, motion, options, doc, win };
}

describe("landing product tour", () => {
  it("keeps the selected topic, count, and accessible slide in step for every control", () => {
    const { nodes, slides } = mount();
    expect(nodes.controls.getAttribute("hidden")).toBeUndefined();
    expect(nodes.count.textContent).toBe("1 / 3");
    expect(nodes.picker.hidden).toBe(false);
    expect(nodes.select.hidden).toBe(true);
    expect(nodes.value.textContent).toBe("Your workspace");
    expect(slides.map((slide) => slide.inert)).toEqual([false, true, true]);

    nodes.next.emit("click");
    expect(nodes.select.value).toBe("1");
    expect(nodes.count.textContent).toBe("2 / 3");
    expect(slides.map((slide) => slide.getAttribute("aria-hidden"))).toEqual([
      "true",
      "false",
      "true",
    ]);

    nodes.select.value = "2";
    nodes.select.emit("change");
    expect(nodes.count.textContent).toBe("3 / 3");
    nodes.prev.emit("click");
    expect(nodes.select.value).toBe("1");
  });

  it("handles viewport navigation keys without taking keys from links or the topic select", () => {
    const { nodes, embla } = mount();
    const preventDefault = vi.fn();
    nodes.viewport.emit("keydown", {
      target: nodes.viewport,
      key: "End",
      preventDefault,
    });
    expect(embla.scrollTo).toHaveBeenLastCalledWith(2);
    nodes.viewport.emit("keydown", {
      target: nodes.viewport,
      key: "Home",
      preventDefault,
    });
    expect(embla.scrollTo).toHaveBeenLastCalledWith(0);
    nodes.viewport.emit("keydown", {
      target: nodes.viewport,
      key: "ArrowRight",
      preventDefault,
    });
    expect(embla.scrollNext).toHaveBeenCalledOnce();
    nodes.viewport.emit("keydown", {
      target: nodes.select,
      key: "ArrowRight",
      preventDefault,
    });
    nodes.viewport.emit("keydown", {
      target: nodes.viewport,
      key: "ArrowLeft",
      altKey: true,
      preventDefault,
    });
    expect(embla.scrollNext).toHaveBeenCalledOnce();
    expect(embla.scrollPrev).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it("respects reduced motion initially and when the preference changes", () => {
    const { factory, embla, motion, nodes } = mount({ reduced: true });
    expect(factory.mock.calls[0][1]).toMatchObject({ duration: 0 });
    nodes.next.emit("click");
    motion.matches = false;
    motion.emit("change");
    expect(embla.reInit).toHaveBeenLastCalledWith({ duration: 20 });
    expect(nodes.select.value).toBe("1");
    motion.matches = true;
    motion.emit("change");
    expect(embla.reInit).toHaveBeenLastCalledWith({ duration: 0 });
  });

  it("opens the topic list and chooses an option without changing the slide on highlight", () => {
    const { nodes, options, embla } = mount();
    nodes.trigger.emit("click");
    expect(nodes.list.hidden).toBe(false);
    expect(nodes.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(nodes.trigger.getAttribute("aria-activedescendant")).toBe("tour-topic-0");
    const preventDefault = vi.fn();
    nodes.trigger.emit("keydown", { key: "End", preventDefault });
    expect(nodes.trigger.getAttribute("aria-activedescendant")).toBe("tour-topic-2");
    expect(embla.scrollTo).not.toHaveBeenCalled();
    nodes.trigger.emit("keydown", { key: "Enter", preventDefault });
    expect(nodes.select.value).toBe("2");
    expect(nodes.value.textContent).toBe("Gallery & templates");
    expect(options[2].getAttribute("aria-selected")).toBe("true");
    expect(nodes.list.hidden).toBe(true);
    expect(nodes.trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
    nodes.trigger.emit("click");
    options[1].emit("click");
    expect(nodes.select.value).toBe("1");
    expect(nodes.list.hidden).toBe(true);
  });

  it("supports arrows, Home, typeahead, and cancellation without selecting the highlight", () => {
    const { nodes, embla } = mount();
    const key = (name) => nodes.trigger.emit("keydown", { key: name, preventDefault: vi.fn() });
    key(" ");
    key("ArrowDown");
    expect(nodes.trigger.getAttribute("aria-activedescendant")).toBe("tour-topic-1");
    key("ArrowUp");
    expect(nodes.trigger.getAttribute("aria-activedescendant")).toBe("tour-topic-0");
    key("g");
    expect(nodes.trigger.getAttribute("aria-activedescendant")).toBe("tour-topic-2");
    key("Home");
    expect(nodes.trigger.getAttribute("aria-activedescendant")).toBe("tour-topic-0");
    key("Escape");
    expect(nodes.list.hidden).toBe(true);
    expect(nodes.trigger.getAttribute("aria-activedescendant")).toBeUndefined();
    expect(nodes.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(nodes.trigger.focus).toHaveBeenCalled();
    expect(embla.scrollTo).not.toHaveBeenCalled();
  });

  it("dismisses on outside interaction and Tab without moving or trapping focus", () => {
    const { nodes, doc, embla } = mount();
    nodes.trigger.emit("click");
    doc.emit("pointerdown", { target: nodes.trigger });
    expect(nodes.list.hidden).toBe(false);
    doc.emit("pointerdown", { target: {} });
    expect(nodes.list.hidden).toBe(true);
    nodes.trigger.emit("click");
    const preventDefault = vi.fn();
    nodes.trigger.emit("keydown", { key: "Tab", preventDefault });
    expect(nodes.list.hidden).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(nodes.trigger.focus).not.toHaveBeenCalled();
    expect(embla.scrollTo).not.toHaveBeenCalled();
    nodes.trigger.emit("click");
    doc.emit("focusin", { target: {} });
    expect(nodes.list.hidden).toBe(true);
  });

  it("fits the popup above a low trigger and retains the native select if custom markup is missing", () => {
    const { nodes, win } = mount();
    win.innerHeight = 450;
    nodes.trigger.emit("click");
    expect(nodes.list.getAttribute("data-side")).toBe("above");
    expect(nodes.list.style.maxHeight).toBe("284px");
    const fallback = mount({ missingPicker: true });
    expect(fallback.nodes.select.hidden).toBe(false);
    expect(fallback.nodes.picker.hidden).toBe(true);
    fallback.nodes.select.value = "1";
    fallback.nodes.select.emit("change");
    expect(fallback.nodes.count.textContent).toBe("2 / 3");
  });

  it("preserves the native tour if enhancement fails", () => {
    const { nodes, slides, classes } = mount({ fail: true });
    expect(classes.has("is-enhanced")).toBe(false);
    expect(nodes.controls.getAttribute("hidden")).toBe("");
    expect(slides.every((slide) => !slide.inert)).toBe(true);
  });
});
