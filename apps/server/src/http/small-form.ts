import { bodyLimit } from "hono/body-limit";

/**
 * Cap for the small HTML forms handled before sign-in (password gate, account
 * switch/sign-out, MCP consent). Real submissions are a few hundred bytes; the cap
 * stops a large body from being buffered before any check runs.
 */
export const SMALL_FORM_MAX_BYTES = 16 * 1024;

export const smallFormLimit = () =>
  bodyLimit({
    maxSize: SMALL_FORM_MAX_BYTES,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  });
