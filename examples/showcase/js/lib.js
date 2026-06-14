/*
 * Shared helpers for the showcase modules. No dependencies, no build step.
 *
 * The served SDK (`/sdk/v1.js`) only exposes `window.canvasdrop` — the typed
 * error *classes* aren't global — so we degrade gracefully by reading the
 * stable `err.code` string the SDK puts on every CanvasdropError.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** The SDK global. Calls are deferred to event time, so this is always set by then. */
export const cd = () => window.canvasdrop;

/** Initials for an avatar fallback. */
export function initials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human-readable, per-section explanation for a CanvasdropError code. */
export function explain(code, capability) {
  switch (code) {
    case "CAPABILITY_DISABLED":
      return (
        `This capability${capability ? ` (${capability})` : ""} is turned off for this canvas. ` +
        `The owner can enable it under Settings → Capabilities; AI also needs a provider key set by the operator.`
      );
    case "NOT_AUTHENTICATED":
      return "You're not signed in. Backend primitives require an authenticated org member.";
    case "QUOTA_EXCEEDED":
    case "KEY_LIMIT":
    case "VALUE_TOO_LARGE":
    case "FILE_TOO_LARGE":
      return "A usage limit was hit (quota or size cap). Try again later or with a smaller payload.";
    default:
      return null;
  }
}

/** Render a non-blocking state card (graceful degradation) into `host`. */
export function showState(host, err) {
  if (!host) return;
  const code = err?.code ?? "REQUEST_FAILED";
  const off = code === "CAPABILITY_DISABLED";
  const msg = explain(code, err?.capability) ?? (err?.message || "Something went wrong.");
  host.innerHTML = "";
  const box = document.createElement("div");
  box.className = `state ${off ? "off" : "err"}`;
  box.innerHTML = `<span class="ico">${off ? "○" : "!"}</span><span><b>${
    off ? "Unavailable" : "Error"
  }</b> — ${escapeHtml(msg)}</span>`;
  host.appendChild(box);
}

export function clearState(host) {
  if (host) host.innerHTML = "";
}

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * Run an async primitive call. On a CanvasdropError, render a state card into
 * `stateHost` (if given) and return `undefined` instead of throwing — so a
 * disabled/limited capability never breaks the rest of the page.
 */
export async function guard(fn, stateHost) {
  try {
    const out = await fn();
    clearState(stateHost);
    return out;
  } catch (err) {
    if (err && typeof err.code === "string") {
      showState(stateHost, err);
      return undefined;
    }
    throw err;
  }
}

/** Append a line to a `.out` element, capping history. */
export function logLine(el, html, max = 8) {
  if (!el) return;
  const line = document.createElement("span");
  line.className = "line";
  line.innerHTML = html;
  el.appendChild(line);
  while (el.children.length > max) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

/** Wire `data-act` click handlers within a root element. */
export function onAct(root, map) {
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || !root.contains(btn)) return;
    const handler = map[btn.dataset.act];
    if (handler) handler(btn, e);
  });
}
