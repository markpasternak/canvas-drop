import type { Config } from "@canvas-drop/shared";

/** DB setting key for the instance display name shown in emails and admin-visible copy. */
export const INSTANCE_NAME_SETTING_KEY = "config.core.instanceName";

/** Default instance display name: the public base URL host, never the org name. */
export function defaultInstanceName(config: Pick<Config, "baseUrl">): string {
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return config.baseUrl;
  }
}
