import { loadConfig } from "@canvas-drop/shared";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../http/types.js";
import { devStrategy } from "./dev.js";

describe("devStrategy", () => {
  it("resolves the configured dev user with zero input", async () => {
    const config = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_DEV_USER_EMAIL: "d@example.com",
      CANVAS_DROP_DEV_USER_NAME: "Dev",
    });
    const identity = await devStrategy(config).resolveIdentity({} as Context<AppEnv>);
    expect(identity).toEqual({ sub: "dev:d@example.com", email: "d@example.com", name: "Dev" });
  });
});
