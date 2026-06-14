/* KV — shared (everyone) vs per-user (private) namespaces. */
import { $, cd, escapeHtml, guard, onAct } from "./lib.js";

const VIEWS_KEY = "showcase:views";
const NOTE_KEY = "showcase:note";

async function loadCounter() {
  const out = $("#kv-counter");
  // Plain read — get() returns null until the first increment writes the key.
  const n = await guard(() => cd().kv.get(VIEWS_KEY), $("#kv-out"));
  out.textContent = typeof n === "number" ? String(n) : "0";
}

export function mount() {
  const sec = $("#sec-kv");
  const out = $("#kv-out");

  onAct(sec, {
    "kv-bump": async () => {
      const n = await guard(() => cd().kv.increment(VIEWS_KEY, 1), out);
      if (typeof n === "number") {
        $("#kv-counter").textContent = String(n);
        out.innerHTML = `<span class="line">shared <span class="key">${escapeHtml(VIEWS_KEY)}</span> → ${n}</span>`;
      }
    },
    "kv-save-note": async () => {
      const text = $("#kv-note").value;
      const ok = await guard(async () => {
        await cd().kv.user.set(NOTE_KEY, text);
        return true;
      }, out);
      if (ok)
        out.innerHTML = `<span class="line">saved to <span class="key">your</span> namespace ✓</span>`;
    },
    "kv-load-note": async () => {
      const val = await guard(() => cd().kv.user.get(NOTE_KEY), out);
      $("#kv-note").value = typeof val === "string" ? val : "";
      out.innerHTML =
        val == null
          ? `<span class="line">no note saved in <span class="key">your</span> namespace yet</span>`
          : `<span class="line">loaded <span class="key">your</span> note: ${escapeHtml(String(val))}</span>`;
    },
  });

  loadCounter();
}
