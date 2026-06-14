import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom doesn't implement scrollTo; the router calls it on navigation.
window.scrollTo = () => {};

// jsdom doesn't implement matchMedia; the app shell uses it to close the mobile
// menu when the viewport crosses the desktop breakpoint. A minimal stub keeps the
// listener real (addEventListener no-ops) without matching any query.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// Lazy route chunks can take just over Testing Library's 1s default when the
// full dashboard suite is transforming modules in parallel.
configure({ asyncUtilTimeout: 5000 });

// Unmount React trees between tests so the DOM doesn't leak across cases.
afterEach(() => {
  cleanup();
});
