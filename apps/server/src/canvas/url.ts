import type { Config } from "@canvas-drop/shared";

/**
 * Build the public URL for a canvas (§8.2). Subdomain mode → `{scheme}//{slug}.{host}/`;
 * path mode → `{base}/c/{slug}/`.
 */
export function canvasUrl(config: Config, slug: string): string {
  if (config.urlMode === "subdomain") {
    const base = new URL(config.baseUrl);
    return `${base.protocol}//${slug}.${base.host}/`;
  }
  return `${config.baseUrl.replace(/\/$/, "")}/c/${slug}/`;
}

/** Absolute base path of the keyed Deploy API for one canvas (`{apiBase}/v1/canvases/{id}`). */
export function deployApiBase(config: Config, canvasId: string): string {
  return `${config.apiBaseUrl.replace(/\/$/, "")}/v1/canvases/${canvasId}`;
}

export interface DeployEndpoints {
  /** Base path; every operation below hangs off it. */
  apiBase: string;
  /** One-shot ZIP publish. */
  zipUpload: string;
  /** Staged upload (preferred for many/large/binary files): begin → blob → finalize. */
  staged: { begin: string; stageBlob: string; finalize: string };
  /** Read back the live version (verify a deploy without fetching the gated URL). */
  readback: string;
  /** Copy-paste one-shot deploy command. Uses the real key when known, else `$CANVAS_KEY`. */
  curl: string;
}

/**
 * Ready-to-use curl endpoints for the keyed Deploy API, returned by the MCP tools so
 * an agent never has to probe for the API host (it differs from the dashboard host in
 * subdomain mode — see CANVAS_DROP_API_BASE_URL). Pass `apiKey` at creation to embed
 * the real Bearer token in the example; otherwise it shows `$CANVAS_KEY`.
 */
export function deployEndpoints(
  config: Config,
  canvasId: string,
  apiKey?: string,
): DeployEndpoints {
  const apiBase = deployApiBase(config, canvasId);
  const bearer = apiKey ?? "$CANVAS_KEY";
  return {
    apiBase,
    zipUpload: `PUT ${apiBase}/deploy`,
    staged: {
      begin: `POST ${apiBase}/uploads`,
      stageBlob: `PUT ${apiBase}/uploads/{uploadId}/blobs/{hash}`,
      finalize: `POST ${apiBase}/uploads/{uploadId}/finalize`,
    },
    readback: `GET ${apiBase}/files`,
    curl: `curl -X PUT "${apiBase}/deploy" -H "Authorization: Bearer ${bearer}" --data-binary @site.zip`,
  };
}
