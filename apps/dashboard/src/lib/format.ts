/** Human-readable byte size (1024-based, one decimal above KB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

/** Relative time ("just now", "3m ago", "2d ago"), with a date fallback. */
export function relativeTime(epochMs: number, now = Date.now()): string {
  const s = Math.round((now - epochMs) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "1m ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Absolute timestamp for tooltips. */
export function fullTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

/** Whole days elapsed since `epochMs` (floored, never negative). For purge-age hints. */
export function daysSince(epochMs: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - epochMs) / 86400000));
}

/** Countdown to a future expiry, or "expired". */
export function expiryLabel(epochMs: number, now = Date.now()): string {
  const s = Math.round((epochMs - now) / 1000);
  if (s <= 0) return "expired";
  const d = Math.floor(s / 86400);
  if (d >= 1) return `expires in ${d}d`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `expires in ${h}h`;
  const m = Math.max(1, Math.floor(s / 60));
  return `expires in ${m}m`;
}
