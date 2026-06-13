import { Hono } from "hono";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../http/types.js";
import { requestLogger } from "./middleware.js";

/** A pino logger that captures each emitted line as a parsed object. */
function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: "info" }, { write: (s: string) => lines.push(JSON.parse(s)) });
  return { logger, lines };
}

function buildApp(logger: ReturnType<typeof captureLogger>["logger"]) {
  const app = new Hono<AppEnv>();
  app.use("*", requestLogger(logger));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/hello", (c) => {
    c.get("log").info("handler ran");
    return c.text("hi");
  });
  return app;
}

describe("requestLogger", () => {
  it("propagates an inbound correlation id to the child logger and the response", async () => {
    const { logger, lines } = captureLogger();
    const res = await buildApp(logger).request("/hello", {
      headers: { "X-Correlation-ID": "test-123" },
    });
    expect(res.headers.get("X-Correlation-ID")).toBe("test-123");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.correlationId === "test-123")).toBe(true);
  });

  it("generates a correlation id when none is provided", async () => {
    const { logger, lines } = captureLogger();
    const res = await buildApp(logger).request("/hello");
    const id = res.headers.get("X-Correlation-ID");
    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.every((l) => l.correlationId === id)).toBe(true);
  });

  it("emits a completion log with method, path, status, and duration", async () => {
    const { logger, lines } = captureLogger();
    await buildApp(logger).request("/hello");
    const end = lines.find((l) => l.msg === "request:end");
    expect(end).toBeDefined();
    expect(end?.method).toBe("GET");
    expect(end?.path).toBe("/hello");
    expect(end?.status).toBe(200);
    expect(typeof end?.durationMs).toBe("number");
  });

  it("does not emit request logs for /healthz", async () => {
    const { logger, lines } = captureLogger();
    const res = await buildApp(logger).request("/healthz");
    expect(res.headers.get("X-Correlation-ID")).toBeTruthy(); // still correlated
    expect(lines.some((l) => l.msg === "request:start" || l.msg === "request:end")).toBe(false);
  });

  it("emits parseable JSON lines (no throw during capture)", async () => {
    const { logger, lines } = captureLogger();
    await buildApp(logger).request("/hello");
    // Every captured line round-tripped through JSON.parse in the destination.
    expect(lines.every((l) => typeof l === "object")).toBe(true);
  });
});
