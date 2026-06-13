/**
 * Browser entry for the served SDK bundle (`GET /sdk/v1.js`). esbuild bundles this
 * into an IIFE that assigns the global `canvasdrop`, auto-detecting the canvas slug
 * + API base from `window.location`. Canvas authors just add one <script> tag.
 */
import { createClient, detectContext } from "./index.js";

declare global {
  interface Window {
    canvasdrop: ReturnType<typeof createClient>;
  }
}

window.canvasdrop = createClient({ context: detectContext(window.location) });
