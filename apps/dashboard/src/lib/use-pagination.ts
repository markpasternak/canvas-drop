/**
 * Derive the "Showing X–Y of N" labels and prev/next gating for an offset-paged
 * list. Extracted from the four list views (Your-canvases, gallery, admin canvases,
 * admin users) that each carried the same arithmetic — keeping it in one place means
 * a clamp fix can't drift between them.
 *
 * `to` is clamped to `total` so a stale-data render (keepPreviousData) can't briefly
 * show "Showing 49–49 of 5" before the page snaps back. `from` is 0 when empty.
 */
export function usePagination({
  total,
  offset,
  itemCount,
  page,
}: {
  total: number;
  offset: number;
  /** Number of items on the CURRENT page (data.items.length). */
  itemCount: number;
  /** 1-based current page. */
  page: number;
}): { from: number; to: number; hasPrev: boolean; hasNext: boolean } {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + itemCount, total);
  const hasPrev = page > 1;
  const hasNext = offset + itemCount < total;
  return { from, to, hasPrev, hasNext };
}
