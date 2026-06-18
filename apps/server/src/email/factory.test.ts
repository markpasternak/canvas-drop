import { type Config, loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import type { Logger } from "../log/logger.js";
import { setupMailer } from "./factory.js";

const silent = { info() {}, error() {}, warn() {} } as unknown as Logger;

/** Build a config then override only the email driver (incl. an off-enum value to
 *  exercise the exhaustiveness default). */
function configWithDriver(driver: string): Config {
  const base = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
  return { ...base, email: { ...base.email, driver: driver as Config["email"]["driver"] } };
}

describe("setupMailer", () => {
  it("builds the log driver for the 'log' case (canSend=true)", () => {
    const m = setupMailer(configWithDriver("log"), silent);
    expect(m.canSend).toBe(true);
  });

  it("builds the noop driver for the 'noop' case (canSend=false)", () => {
    const m = setupMailer(configWithDriver("noop"), silent);
    expect(m.canSend).toBe(false);
  });

  it("throws on an unknown driver rather than silently falling through to log", () => {
    expect(() => setupMailer(configWithDriver("carrier-pigeon"), silent)).toThrow(
      /unknown email driver/,
    );
  });
});
