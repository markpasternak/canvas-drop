import type { AdminCanvasesSearch } from "../router.js";

export const CANVAS_BOOLEAN_FILTERS = [
  { key: "public", label: "Effective public link" },
  { key: "password", label: "Password" },
  { key: "external", label: "External people" },
  { key: "pending", label: "Pending access" },
  { key: "templatable", label: "Template" },
  { key: "listed", label: "Gallery listing" },
] as const;

export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function choice<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.find((option) => option === value);
}

/** Treat URLs and browser storage as untrusted input. Never save arbitrary route keys. */
export function normalizeAdminCanvasSearch(input: unknown): AdminCanvasesSearch {
  const v = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const result: AdminCanvasesSearch = {
    status: choice(v.status, ["active", "disabled", "archived", "deleted"]),
    access: choice(v.access, [
      "private",
      "restricted",
      "specific_people",
      "team",
      "whole_org",
      "public_link",
    ]),
    expiry: choice(v.expiry, ["none", "active", "expired", "not_expired"]),
    context: choice(v.context, ["personal", "org", "team"]),
    sort: choice(v.sort, ["recent", "created", "title"]),
  };
  for (const { key } of CANVAS_BOOLEAN_FILTERS) result[key] = optionalBoolean(v[key]);
  for (const key of ["q", "owner", "person"] as const) {
    if (typeof v[key] === "string")
      result[key] = v[key].trim().slice(0, key === "owner" ? 100 : 200) || undefined;
  }
  const page = typeof v.page === "number" || typeof v.page === "string" ? Number(v.page) : 1;
  if (Number.isSafeInteger(page) && page > 1) result.page = page;
  return result;
}

export function adminCanvasConditions(
  search: AdminCanvasesSearch,
): Array<{ key: keyof AdminCanvasesSearch; label: string }> {
  const conditions: Array<{ key: keyof AdminCanvasesSearch; label: string }> = [];
  for (const { key, label } of CANVAS_BOOLEAN_FILTERS) {
    if (search[key] !== undefined)
      conditions.push({ key, label: `${label}: ${search[key] ? "Yes" : "No"}` });
  }
  const expiryLabels = {
    none: "No expiry",
    active: "Expires later",
    expired: "Expired",
    not_expired: "Not expired",
  };
  const accessLabels = {
    private: "Restricted",
    restricted: "Restricted",
    specific_people: "Restricted",
    team: "Restricted",
    whole_org: "Whole org",
    public_link: "Public link",
  };
  if (search.access)
    conditions.push({ key: "access", label: `Configured access: ${accessLabels[search.access]}` });
  if (search.expiry) conditions.push({ key: "expiry", label: expiryLabels[search.expiry] });
  for (const key of ["status", "context", "owner", "person", "q"] as const) {
    if (search[key])
      conditions.push({ key, label: `${key === "q" ? "Search" : key}: ${search[key]}` });
  }
  return conditions;
}
