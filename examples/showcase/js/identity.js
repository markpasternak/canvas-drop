/* Identity — canvasdrop.me() reads the viewer's server-verified org identity. */
import { $, cd, escapeHtml, guard, initials, onAct } from "./lib.js";

let cachedMe = null;

/** Shared so other modules (realtime presence highlighting, etc.) can reuse it. */
export function getMe() {
  return cachedMe;
}

async function load() {
  const strip = $("#whoami");
  const stateHost = $("#whoami-state");
  const me = await guard(() => cd().me(), stateHost);
  if (!me) {
    strip.hidden = true;
    return;
  }
  cachedMe = me;
  $("#whoami-name").textContent = me.name || me.email;
  $("#whoami-email").textContent = me.name ? ` · ${me.email}` : "";
  const av = $("#whoami-avatar");
  if (me.avatarUrl) {
    av.innerHTML = `<img src="${escapeHtml(me.avatarUrl)}" alt="" />`;
  } else {
    av.textContent = initials(me.name || me.email);
  }
  strip.hidden = false;
}

function renderMeOut(me) {
  const out = $("#me-out");
  if (!me) return;
  out.innerHTML = [
    `<span class="line"><span class="key">name </span>${escapeHtml(me.name || "—")}</span>`,
    `<span class="line"><span class="key">email </span>${escapeHtml(me.email)}</span>`,
    `<span class="line"><span class="key">id </span>${escapeHtml(me.id)}</span>`,
  ].join("");
}

export function mount() {
  onAct($("#sec-identity"), {
    "me-refresh": async () => {
      const me = await guard(() => cd().me(), $("#me-out"));
      if (me) {
        cachedMe = me;
        renderMeOut(me);
      }
    },
  });
  // Populate the header strip immediately, and the section output too.
  load().then(() => renderMeOut(cachedMe));
}
