import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom doesn't implement scrollTo; the router calls it on navigation.
window.scrollTo = () => {};

// Lazy route chunks can take just over Testing Library's 1s default when the
// full dashboard suite is transforming modules in parallel.
configure({ asyncUtilTimeout: 5000 });

// Unmount React trees between tests so the DOM doesn't leak across cases.
afterEach(() => {
  cleanup();
});
