import { VERSION } from "@canvas-drop/shared";

/**
 * Server entrypoint placeholder. The real app assembly (Hono wiring,
 * config load, factories, `/healthz`, boot) lands in U11.
 *
 * The cross-package import above proves workspace resolution and typechecking
 * work end-to-end from U1.
 */
export const serverVersion: string = VERSION;
