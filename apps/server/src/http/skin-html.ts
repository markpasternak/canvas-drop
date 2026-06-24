import { type SkinName, skinOverridesCss } from "@canvas-drop/shared";

/**
 * Shared design-skin HTML helpers for the server-rendered, pre-gateway surfaces
 * (the landing page, the docs site, and the legal pages). These exist so the
 * skin "wearing" mechanism can't drift between surfaces: there is ONE place that
 * decides how a skin is stamped on `<html>` and ONE place that emits the
 * `[data-skin]` token-override CSS (which itself derives from the canonical
 * `skinOverridesCss()` in `@canvas-drop/shared`, the same source the dashboard's
 * hand-authored tokens.css derives from).
 *
 * Invariant (matches the SPA's `applySkin`): the default `editorial` skin is the
 * attribute-free base `:root`, so it stamps NOTHING — there is never a
 * `[data-skin="editorial"]` rule or attribute. Only the alternates carry the
 * attribute, selecting their override block.
 */

/**
 * Render the opening `<html>` tag with the skin stamped on, for a non-default
 * skin only. `attrs` lets a surface add its own root attributes (e.g. the legal
 * pages' forced `data-theme="dark"`). Editorial → no `data-skin`.
 *
 *   skinnedHtmlTag("studio")                     → `<html lang="en" data-skin="studio">`
 *   skinnedHtmlTag("editorial")                  → `<html lang="en">`
 *   skinnedHtmlTag("canvas", 'data-theme="dark"') → `<html lang="en" data-theme="dark" data-skin="canvas">`
 */
export function skinnedHtmlTag(skin: SkinName, attrs = ""): string {
  const extra = attrs ? ` ${attrs}` : "";
  const skinAttr = skin === "editorial" ? "" : ` data-skin="${skin}"`;
  return `<html lang="en"${extra}${skinAttr}>`;
}

/**
 * The `[data-skin]` token-override CSS block, ready to drop inside a surface's
 * inlined `<style>`. Wraps the canonical {@link skinOverridesCss} so every surface
 * emits the SAME accent-family + display-bundle overrides from one source.
 *
 * `darkToggle` adds the manual `[data-theme="dark"]` skin selectors — pass it for
 * surfaces that expose a theme toggle (the docs) so a stored dark choice keeps the
 * skin accents; leave it off for OS-only surfaces (the landing).
 */
export function skinStyleCss(opts: { darkToggle?: boolean } = {}): string {
  return `/* Design-skin overrides (expression layer): selected by <html data-skin>. */
${skinOverridesCss(opts)}`;
}
