import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom doesn't implement scrollTo; the router calls it on navigation.
window.scrollTo = () => {};

// Unmount React trees between tests so the DOM doesn't leak across cases.
afterEach(() => {
  cleanup();
});
