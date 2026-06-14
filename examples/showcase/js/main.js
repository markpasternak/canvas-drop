/*
 * Entry point. Modules are deferred (type=module), so the DOM is parsed and
 * `window.canvasdrop` (a classic <script> in <head>) is already defined.
 * Each section mounts independently and degrades on its own — one disabled
 * capability never breaks the others.
 */

import { mount as ai } from "./ai.js";
import { mount as files } from "./files.js";
import { mount as identity } from "./identity.js";
import { mount as kv } from "./kv.js";
import { mount as realtime } from "./realtime.js";

for (const mount of [identity, kv, files, ai, realtime]) {
  try {
    mount();
  } catch (err) {
    // A thrown mount must not take down the rest of the page.
    console.error("[showcase] section failed to mount:", err);
  }
}
