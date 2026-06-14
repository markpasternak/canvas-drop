/** The canonical "deploy with the API" curl command, shared by the create flow
 *  (which has the real secret key, shown once) and the canvas settings view
 *  (which can never re-show the key, so it passes a placeholder). Keeping a single
 *  builder means the two surfaces can't drift. */
export function deployCurl({
  url,
  id,
  apiKey,
}: {
  /** Any canvas URL — only its origin is used for the API endpoint. */
  url: string;
  id: string;
  /** The live key in the create flow; a placeholder like `$CANVAS_DROP_KEY` in settings. */
  apiKey: string;
}): string {
  return `curl -X PUT "${new URL(url).origin}/v1/canvases/${id}/deploy" \\
  -H "Authorization: Bearer ${apiKey}" \\
  --data-binary @site.zip`;
}
