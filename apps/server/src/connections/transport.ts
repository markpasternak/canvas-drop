import { lookup as dnsLookup } from "node:dns/promises";
import { type IncomingHttpHeaders, validateHeaderName, validateHeaderValue } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import {
  buildConnectionTarget,
  isPublicAddress,
  normalizeConnectionOrigin,
} from "./address-policy.js";

export type ConnectionMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ConnectionTransportErrorCode =
  | "INVALID_BODY"
  | "METHOD_NOT_ALLOWED"
  | "DESTINATION_BLOCKED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "RESPONSE_TOO_LARGE";

export class ConnectionTransportError extends Error {
  constructor(
    readonly code: ConnectionTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionTransportError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface RawConnectionResponse {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
  readonly destroyed?: boolean;
}

export interface ConnectionRequestAdapterInput {
  url: URL;
  method: ConnectionMethod;
  headers: Headers;
  body?: Uint8Array;
  address: ResolvedAddress;
  signal: AbortSignal;
}

export type ConnectionRequestAdapter = (
  input: ConnectionRequestAdapterInput,
) => Promise<RawConnectionResponse>;

export interface ConnectionTransportDeps {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  request: ConnectionRequestAdapter;
}

export interface ConnectionFetchInput {
  origin: string;
  path: string;
  method: ConnectionMethod;
  allowedMethods: readonly ConnectionMethod[];
  callerHeaders: readonly (readonly [name: string, value: string])[];
  protectedHeaders: readonly (readonly [name: string, value: string])[];
  body?: Uint8Array;
  maxResponseBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  signal?: AbortSignal;
}

export interface ConnectionFetchResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

const MAX_CALLER_HEADERS = 32;
const MAX_CALLER_HEADER_BYTES = 16 * 1024;

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

const SAFE_RESPONSE_HEADERS = new Set([
  "content-language",
  "content-type",
  "etag",
  "last-modified",
  "retry-after",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function fail(code: ConnectionTransportErrorCode, message: string): never {
  throw new ConnectionTransportError(code, message);
}

function validateHeader(name: string, value: string): string {
  const normalized = name.toLowerCase();
  try {
    validateHeaderName(normalized);
    validateHeaderValue(normalized, value);
  } catch {
    fail("INVALID_BODY", "connection request contains an invalid header");
  }
  return normalized;
}

export function prepareConnectionHeaders(
  caller: readonly (readonly [string, string])[],
  protectedHeaders: readonly (readonly [string, string])[],
): Headers {
  if (caller.length > MAX_CALLER_HEADERS) {
    fail("INVALID_BODY", "connection request has too many headers");
  }
  let callerBytes = 0;
  const protectedNames = new Set<string>();
  const fixed = new Map<string, string>();
  for (const [name, value] of protectedHeaders) {
    const normalized = validateHeader(name, value);
    if (FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
      fail("INVALID_BODY", "connection profile contains a forbidden protected header");
    }
    if (protectedNames.has(normalized)) {
      fail("INVALID_BODY", "connection profile contains a duplicate protected header");
    }
    protectedNames.add(normalized);
    fixed.set(normalized, value);
  }

  const result = new Headers();
  const seen = new Set<string>();
  for (const [name, value] of caller) {
    callerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (callerBytes > MAX_CALLER_HEADER_BYTES) {
      fail("INVALID_BODY", "connection request headers are too large");
    }
    const normalized = validateHeader(name, value);
    if (seen.has(normalized)) fail("INVALID_BODY", "connection request has duplicate headers");
    seen.add(normalized);
    if (protectedNames.has(normalized)) {
      fail("INVALID_BODY", "connection request cannot override a protected header");
    }
    if (!FORBIDDEN_REQUEST_HEADERS.has(normalized)) result.set(normalized, value);
  }
  result.set("accept-encoding", "identity");
  for (const [name, value] of fixed) result.set(name, value);
  return result;
}

function safeResponseHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of headers) {
    if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) result.set(name, value);
  }
  return result;
}

function redirectedMethod(status: number, method: ConnectionMethod): ConnectionMethod {
  if ((status === 301 || status === 302) && method === "POST") return "GET";
  if (status === 303 && method !== "HEAD") return "GET";
  return method;
}

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

class OperationAbortedError extends Error {
  constructor() {
    super("connection operation was aborted");
    this.name = "OperationAbortedError";
  }
}

function waitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort?.();
      reject(new OperationAbortedError());
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBoundedBody(
  response: RawConnectionResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return waitWithSignal(
    (async () => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for await (const chunk of response.body) {
          total += chunk.byteLength;
          if (total > maxBytes) fail("RESPONSE_TOO_LARGE", "connection response is too large");
          chunks.push(chunk);
        }
      } catch (error) {
        response.destroy();
        throw error;
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    })(),
    signal,
    () => response.destroy(),
  );
}

export function connectionTransport(deps: ConnectionTransportDeps) {
  return {
    async fetch(input: ConnectionFetchInput): Promise<ConnectionFetchResult> {
      const origin = normalizeConnectionOrigin(input.origin);
      if (!input.allowedMethods.includes(input.method)) {
        fail("METHOD_NOT_ALLOWED", "connection method is not allowed");
      }
      let url = buildConnectionTarget(origin, input.path);
      let method = input.method;
      let body = input.body;
      let headers = prepareConnectionHeaders(input.callerHeaders, input.protectedHeaders);
      let timedOut = false;
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) abortFromCaller();
      else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("connection request timed out"));
      }, input.timeoutMs);

      try {
        for (let redirects = 0; ; redirects += 1) {
          let addresses: ResolvedAddress[];
          try {
            addresses = await waitWithSignal(deps.resolve(url.hostname), controller.signal);
          } catch (error) {
            if (timedOut) fail("UPSTREAM_TIMEOUT", "connection request timed out");
            if (error instanceof OperationAbortedError) {
              fail("UPSTREAM_UNAVAILABLE", "connection request was aborted");
            }
            fail("DESTINATION_BLOCKED", "connection destination could not be resolved");
          }
          if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address))) {
            fail("DESTINATION_BLOCKED", "connection destination is not public");
          }
          const address = addresses[0];
          if (!address) fail("DESTINATION_BLOCKED", "connection destination could not be resolved");

          let response: RawConnectionResponse;
          try {
            response = await waitWithSignal(
              deps.request({ url, method, headers, body, address, signal: controller.signal }),
              controller.signal,
            );
          } catch (error) {
            if (timedOut) fail("UPSTREAM_TIMEOUT", "connection request timed out");
            if (error instanceof ConnectionTransportError) throw error;
            fail("UPSTREAM_UNAVAILABLE", "connection upstream is unavailable");
          }

          if (isRedirect(response.status)) {
            const location = response.headers.get("location");
            if (!location || redirects >= input.maxRedirects) {
              response.destroy();
              fail("DESTINATION_BLOCKED", "connection redirect is invalid or exceeds the limit");
            }
            let next: URL;
            try {
              next = new URL(location, url);
            } catch {
              response.destroy();
              fail("DESTINATION_BLOCKED", "connection redirect is invalid");
            }
            if (next.origin !== origin || next.username || next.password) {
              response.destroy();
              fail("DESTINATION_BLOCKED", "connection redirect leaves the approved origin");
            }
            const nextMethod = redirectedMethod(response.status, method);
            if (!input.allowedMethods.includes(nextMethod)) {
              response.destroy();
              fail("METHOD_NOT_ALLOWED", "connection redirect method is not allowed");
            }
            response.destroy();
            if (nextMethod === "GET" && method !== "GET") {
              body = undefined;
              headers = new Headers(headers);
              headers.delete("content-type");
            }
            method = nextMethod;
            url = next;
            continue;
          }

          const contentEncoding = response.headers.get("content-encoding");
          if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
            response.destroy();
            fail("UPSTREAM_UNAVAILABLE", "connection upstream returned an unsupported encoding");
          }
          if (method === "HEAD") {
            response.destroy();
            return {
              status: response.status,
              headers: safeResponseHeaders(response.headers),
              body: new Uint8Array(),
            };
          }
          return {
            status: response.status,
            headers: safeResponseHeaders(response.headers),
            body: await readBoundedBody(response, input.maxResponseBytes, controller.signal),
          };
        }
      } catch (error) {
        if (timedOut && !(error instanceof ConnectionTransportError)) {
          fail("UPSTREAM_TIMEOUT", "connection request timed out");
        }
        if (error instanceof OperationAbortedError) {
          fail("UPSTREAM_UNAVAILABLE", "connection request was aborted");
        }
        throw error;
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}

export function buildPinnedRequestOptions(input: {
  url: URL;
  method: ConnectionMethod;
  headers: Headers;
  address: ResolvedAddress;
  signal: AbortSignal;
}): RequestOptions {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [input.address]);
    else callback(null, input.address.address, input.address.family);
  };
  return {
    protocol: "https:",
    hostname: input.url.hostname,
    servername: input.url.hostname,
    port: input.url.port ? Number(input.url.port) : 443,
    path: `${input.url.pathname}${input.url.search}`,
    method: input.method,
    headers: Object.fromEntries(input.headers.entries()),
    lookup,
    signal: input.signal,
  };
}

function incomingHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

export const nodeConnectionRequest: ConnectionRequestAdapter = (input) =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(buildPinnedRequestOptions(input), (response) => {
      resolve({
        status: response.statusCode ?? 502,
        headers: incomingHeaders(response.headers),
        body: response,
        destroy: () => response.destroy(),
        get destroyed() {
          return response.destroyed;
        },
      });
    });
    request.once("error", reject);
    if (input.body) request.write(input.body);
    request.end();
  });

export async function resolveConnectionHost(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new Error("connection DNS lookup returned an unknown address family");
    }
    return { address, family };
  });
}

export const defaultConnectionTransport = connectionTransport({
  resolve: resolveConnectionHost,
  request: nodeConnectionRequest,
});
