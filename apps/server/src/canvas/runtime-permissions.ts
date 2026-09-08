import { audienceAllows, type RuntimeRole } from "@canvas-drop/shared";
import type { Context } from "hono";
import type { AppEnv } from "../http/types.js";

export function canEditRuntime(c: Context<AppEnv>): boolean {
  const role = c.get("runtimeRole");
  return role === "owner" || role === "editor";
}

export function permissionDenied(c: Context<AppEnv>, action: string) {
  return c.json(
    {
      code: "PERMISSION_DENIED",
      message: `Your canvas role cannot ${action}.`,
      hint: "Only the canvas owner or an editor can perform this action.",
    },
    403,
  );
}

export function runtimeAudienceAllows(c: Context<AppEnv>, audience: string): boolean {
  const role: RuntimeRole = c.get("runtimeRole") ?? "viewer";
  return audienceAllows(audience, role);
}
