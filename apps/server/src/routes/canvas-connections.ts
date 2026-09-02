import type { Config } from "@canvas-drop/shared";
import type { ConnectionMethod, Json } from "@canvas-drop/shared/db";
import { type Context, Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { ConnectionLimitError, type ConnectionLimits } from "../connections/limits.js";
import { SecretCipherError } from "../connections/secret-cipher.js";
import { type ConnectionService, ConnectionServiceError } from "../connections/service.js";
import {
  type ConnectionFetchResult,
  ConnectionTransportError,
  type connectionTransport,
} from "../connections/transport.js";
import { CONNECTION_METHODS } from "../connections/validation.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import { requireCanvas } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";

export const CONNECTION_RESPONSE_MARKER = "x-canvas-drop-connection-response";

// Browsers attach User-Agent to every fetch but do not let canvas JavaScript author it.
// It is transport metadata, not a caller override of an admin-protected upstream header.
const BROWSER_AMBIENT_HEADERS = new Set(["user-agent"]);

export interface CanvasConnectionsDeps {
  config: Config;
  service: ConnectionService;
  transport: ReturnType<typeof connectionTransport>;
  limits: ConnectionLimits;
  usage: UsageEventsRepository;
}

interface RuntimeErrorView {
  status: number;
  code: string;
  message: string;
  retryAfter?: number;
}

function runtimeError(error: unknown): RuntimeErrorView {
  if (error instanceof ConnectionLimitError) {
    return {
      status: 429,
      code: error.code,
      message: error.message,
      retryAfter: error.retryAfterSeconds,
    };
  }
  if (error instanceof ConnectionServiceError) {
    return {
      status: error.code === "CONNECTION_NOT_GRANTED" ? 404 : 503,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof SecretCipherError) {
    return {
      status: 503,
      code: "CONNECTION_KEY_UNAVAILABLE",
      message: "connection credentials are unavailable",
    };
  }
  if (error instanceof ConnectionTransportError) {
    const statuses: Record<string, number> = {
      INVALID_BODY: 400,
      REQUEST_TOO_LARGE: 413,
      METHOD_NOT_ALLOWED: 405,
      DESTINATION_BLOCKED: 403,
      UPSTREAM_TIMEOUT: 504,
      UPSTREAM_UNAVAILABLE: 502,
      RESPONSE_TOO_LARGE: 502,
    };
    return {
      status: statuses[error.code] ?? 502,
      code: error.code,
      message: error.message,
    };
  }
  throw error;
}

function platformResponse(c: Context<AppEnv>, error: RuntimeErrorView) {
  if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
  c.header("Cache-Control", "private, no-store");
  return c.json({ code: error.code, message: error.message }, error.status as 400);
}

function upstreamResponse(c: Context<AppEnv>, result: ConnectionFetchResult) {
  const headers = new Headers();
  for (const name of ["content-language", "content-type", "etag", "last-modified", "retry-after"]) {
    const value = result.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(CONNECTION_RESPONSE_MARKER, "upstream");
  headers.set("access-control-expose-headers", CONNECTION_RESPONSE_MARKER);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox");
  const bodyForbidden = c.req.method === "HEAD" || [204, 205, 304].includes(result.status);
  return c.newResponse(
    bodyForbidden ? null : Uint8Array.from(result.body),
    result.status as StatusCode,
    Object.fromEntries(headers.entries()),
  );
}

function callerHeaders(request: Request): [string, string][] {
  return [...request.headers.entries()].filter(
    ([name]) => !BROWSER_AMBIENT_HEADERS.has(name.toLowerCase()),
  );
}

async function readRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ConnectionTransportError(
          "REQUEST_TOO_LARGE",
          "connection request body is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Transparent, bounded request forwarder for one live admin grant. */
export function canvasConnectionsRoutes(deps: CanvasConnectionsDeps) {
  const app = new Hono<AppEnv>();

  const handle = async (c: Context<AppEnv>) => {
    const startedAt = Date.now();
    const canvas = requireCanvas(c);
    const user = c.get("user");
    const key = c.req.param("key") ?? "";
    let profileId: string | undefined;
    let origin: string | undefined;
    const method = c.req.method.toUpperCase();
    let admission: ReturnType<ConnectionLimits["acquire"]> | undefined;
    let outcome = "platform_rejection";
    let upstreamStatus: number | undefined;
    let requestBytes = 0;
    let responseBytes = 0;
    try {
      if (!canvas.backendEnabled) {
        outcome = "capability_disabled";
        c.header("Cache-Control", "private, no-store");
        return c.json(
          {
            code: "CAPABILITY_DISABLED",
            capability: "connections",
            reason: "backend_off",
            hint: "Turn on this canvas's Backend master switch.",
          },
          403,
        );
      }
      if (!(CONNECTION_METHODS as readonly string[]).includes(method)) {
        throw new ConnectionTransportError(
          "METHOD_NOT_ALLOWED",
          "connection method is not supported",
        );
      }
      const profile = await deps.service.resolveRuntime(canvas.id, key);
      profileId = profile.id;
      origin = profile.origin;
      if (!profile.allowedMethods.includes(method as ConnectionMethod)) {
        throw new ConnectionTransportError(
          "METHOD_NOT_ALLOWED",
          "connection method is not allowed",
        );
      }
      admission = deps.limits.acquire({
        actorId: user.id,
        canvasId: canvas.id,
        profileId: profile.id,
      });
      const contentLength = c.req.header("content-length");
      const declaredLength = contentLength === undefined ? undefined : Number(contentLength);
      if (
        declaredLength !== undefined &&
        (!Number.isSafeInteger(declaredLength) ||
          declaredLength < 0 ||
          declaredLength > deps.config.connections.maxBodyBytes)
      ) {
        throw new ConnectionTransportError(
          "REQUEST_TOO_LARGE",
          "connection request body is too large",
        );
      }
      const rawBody =
        method === "GET" || method === "HEAD"
          ? undefined
          : await readRequestBody(c.req.raw, deps.config.connections.maxBodyBytes);
      requestBytes = rawBody?.byteLength ?? 0;
      const routePrefix = `/v1/c/${c.req.param("slug")}/connections/${key}`;
      const relativePath = c.req.path.startsWith(routePrefix)
        ? c.req.path.slice(routePrefix.length) || "/"
        : "/";
      const search = new URL(c.req.url).search;
      const result = await deps.transport.fetch({
        origin: profile.origin,
        path: `${relativePath}${search}`,
        method: method as ConnectionMethod,
        allowedMethods: profile.allowedMethods,
        callerHeaders: callerHeaders(c.req.raw),
        protectedHeaders: Object.entries(profile.protectedHeaders),
        body: rawBody,
        maxResponseBytes: deps.config.connections.maxResponseBytes,
        timeoutMs: deps.config.connections.timeoutMs,
        maxRedirects: deps.config.connections.maxRedirects,
        maxUrlBytes: deps.config.connections.maxUrlBytes,
        maxCallerHeaders: deps.config.connections.maxCallerHeaders,
        maxCallerHeaderBytes: deps.config.connections.maxCallerHeaderBytes,
        signal: c.req.raw.signal,
      });
      outcome =
        result.status >= 500 ? "upstream_5xx" : result.status >= 400 ? "upstream_4xx" : "success";
      upstreamStatus = result.status;
      responseBytes = result.body.byteLength;
      return upstreamResponse(c, result);
    } catch (error) {
      const response = runtimeError(error);
      outcome = response.code.toLowerCase();
      return platformResponse(c, response);
    } finally {
      admission?.release();
      const meta: Record<string, Json> = {
        key,
        method,
        outcome,
        durationMs: Date.now() - startedAt,
        requestBytes,
        responseBytes,
      };
      if (profileId) meta.profileId = profileId;
      if (origin) meta.origin = origin;
      if (upstreamStatus !== undefined) meta.upstreamStatus = upstreamStatus;
      void deps.usage
        .record({ canvasId: canvas.id, userId: user.id, type: "connection_op", meta })
        .catch(() => {});
    }
  };

  app.all("/:key", handle);
  app.all("/:key/*", handle);
  return app;
}
