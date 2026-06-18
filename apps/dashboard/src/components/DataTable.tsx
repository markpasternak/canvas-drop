import type { ReactNode } from "react";

/** A single header cell. `align: "right"` mirrors the numeric columns; `srOnly`
 *  carries the accessible name for the actions gutter (no visible label). */
export interface DataTableColumn {
  /** Header label. Omit for the actions gutter (use `srOnly` instead). */
  header?: ReactNode;
  align?: "left" | "right";
  /** Accessible name for a label-less column (e.g. the per-row actions gutter). */
  srOnly?: string;
  /** Stable key when the header is non-string. Falls back to the index. */
  key?: string;
}

/**
 * The shared admin-table chrome: a horizontally-scrollable bordered surface, a
 * sticky-toned header row in `surface-sunken`, hairline row borders, and an
 * optional empty state. Extracted from the byte-identical chrome in
 * {@link AdminCanvasTable} and {@link AdminUserTable}; callers supply their own
 * header columns and `<tr>` rows (as children) so cell content is unchanged.
 */
export function DataTable({
  columns,
  children,
  empty,
  isEmpty = false,
}: {
  columns: DataTableColumn[];
  /** The `<tr>` rows for the table body. */
  children: ReactNode;
  /** Rendered in place of the body when `isEmpty`. */
  empty?: ReactNode;
  isEmpty?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-border border-b bg-surface-sunken text-xs text-muted">
          <tr>
            {columns.map((col, i) => (
              <th
                // Header columns are static and order-stable, so the index is a
                // legitimate fallback key when the caller gives no explicit one.
                key={col.key ?? i}
                className={`px-3 py-2 font-medium${col.align === "right" ? " text-right" : ""}`}
                aria-label={col.srOnly}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {isEmpty ? (
            <tr>
              <td className="px-3 py-8 text-center text-muted" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}
