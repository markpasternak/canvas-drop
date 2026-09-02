import { isRestrictedRung } from "../db/types.js";

/**
 * The effective audience of a canvas — WHO ELSE can open it beyond the owner, the editors,
 * and the people-and-teams list (which applies at every value; restricted access model).
 * Derived, never stored, from the persisted `access` value:
 *
 *  - `restricted`  — `private` and its legacy aliases `specific_people` / `team`: nobody
 *                     beyond the list.
 *  - `whole_org`   — any signed-in org member (the canvas's home org under tenancy).
 *  - `public_link` — anyone with the URL (static files only for the anonymous public).
 *
 * This is the field consumers should branch on instead of the raw `access` value, whose
 * three legacy spellings of "restricted" would otherwise have to be known by every client.
 * Audience is deliberately separate from lifecycle ({@link publicationStatusOf}): a
 * restricted canvas with people on its list is published and reachable by them.
 */
export type AccessMode = "restricted" | "whole_org" | "public_link";

/** Map a persisted `access` value to its {@link AccessMode}. Unknown values read as
 *  `restricted` (fail closed — the narrowest audience). */
export function accessModeOf(access: string): AccessMode {
  if (access === "whole_org" || access === "public_link") return access;
  if (isRestrictedRung(access)) return "restricted";
  return "restricted";
}
