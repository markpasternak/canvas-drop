/**
 * The canvas-drop brand mark (frame + falling-drop arrow), driven by the
 * `--logo-frame` / `--logo-drop` CSS vars so it adapts to light/dark. Shared by
 * the self-rendered public pages (landing, legal) so a logo change is a single
 * edit rather than parallel copies that silently drift.
 */
export const BRAND_MARK = `<svg class="mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <path d="M14 37h-4a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5h28a5 5 0 0 1 5 5v21a5 5 0 0 1-5 5h-4" stroke="var(--logo-frame)" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
  <path d="M24 14v16.5m-7-7 7 7 7-7" stroke="var(--logo-drop)" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
  <path d="M18 40h12" stroke="var(--logo-drop)" stroke-linecap="round" stroke-width="4.75"/>
</svg>`;
