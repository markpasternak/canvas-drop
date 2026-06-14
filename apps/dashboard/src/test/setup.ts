import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom doesn't implement scrollTo; the router calls it on navigation.
window.scrollTo = () => {};

// Browser APIs commonly used by layout/theme libraries but absent in jsdom.
window.matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

globalThis.IntersectionObserver ??= class IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};

// Lazy route chunks can take just over Testing Library's 1s default when the
// full dashboard suite is transforming modules in parallel.
configure({ asyncUtilTimeout: 5000 });

// Unmount React trees between tests so the DOM doesn't leak across cases.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
