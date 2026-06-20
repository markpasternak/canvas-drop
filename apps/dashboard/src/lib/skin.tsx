import { useEffect } from "react";
import type { DesignSkin } from "./api.js";
import { useMe } from "./queries.js";

/** localStorage key the pre-paint script in index.html reads to avoid a skin flash. */
const KEY = "canvas-drop-skin";
const SKINS: readonly DesignSkin[] = ["editorial", "studio", "workshop", "canvas"];

/** Apply a design skin to <html data-skin>, and cache it for the pre-paint script.
 *  editorial is the base :root, so it's represented as "no attribute" (and cleared
 *  from storage) — keeping the default path attribute-free and matching index.html. */
function applySkin(skin: DesignSkin) {
  const el = document.documentElement;
  if (skin === "editorial") el.removeAttribute("data-skin");
  else el.setAttribute("data-skin", skin);
  try {
    if (skin === "editorial") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, skin);
  } catch {
    /* private mode — non-fatal */
  }
}

/**
 * Applies the instance's design skin (the expression layer) to `<html data-skin>`.
 * The skin is instance-wide config delivered on `/api/me` (admin-set, NOT a per-user
 * preference — that axis is light/dark). Caching it in localStorage lets index.html's
 * pre-paint script set the attribute before first paint on reload, so the app never
 * flashes editorial before resolving the configured skin. Renders nothing.
 */
export function SkinSync() {
  const skin = useMe().data?.designSkin;
  useEffect(() => {
    if (skin && SKINS.includes(skin)) applySkin(skin);
  }, [skin]);
  return null;
}
