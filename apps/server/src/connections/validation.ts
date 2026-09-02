import type { ConnectionMethod } from "@canvas-drop/shared/db";
import { normalizeConnectionOrigin } from "./address-policy.js";
import { prepareConnectionHeaders } from "./transport.js";

export const CONNECTION_METHODS: readonly ConnectionMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

const RESERVED_KEYS = new Set(["admin", "api", "assets", "connections", "docs", "mcp"]);

export class ConnectionValidationError extends Error {
  constructor(
    readonly code: "INVALID_PROFILE_KEY" | "INVALID_PROFILE" | "INVALID_PROTECTED_HEADERS",
    message: string,
  ) {
    super(message);
    this.name = "ConnectionValidationError";
  }
}

export interface ProtectedHeaderInput {
  name: string;
  value: string;
}

export function validateProfileKey(value: string): string {
  const key = value.trim();
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(key) || RESERVED_KEYS.has(key)) {
    throw new ConnectionValidationError(
      "INVALID_PROFILE_KEY",
      "profile key must be lowercase, URL-safe, and not reserved",
    );
  }
  return key;
}

export function validateProfileLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 100) {
    throw new ConnectionValidationError(
      "INVALID_PROFILE",
      "profile label must be 1-100 characters",
    );
  }
  return label;
}

export function validateMethods(values: readonly string[]): ConnectionMethod[] {
  const methods = [...new Set(values.map((value) => value.toUpperCase()))];
  if (
    methods.length === 0 ||
    methods.some((method) => !(CONNECTION_METHODS as readonly string[]).includes(method))
  ) {
    throw new ConnectionValidationError(
      "INVALID_PROFILE",
      "profile must allow standard methods only",
    );
  }
  return methods as ConnectionMethod[];
}

export function validateOrigin(value: string): string {
  try {
    return normalizeConnectionOrigin(value.trim());
  } catch {
    throw new ConnectionValidationError(
      "INVALID_PROFILE",
      "profile origin must be an HTTPS DNS origin without path, credentials, query, or fragment",
    );
  }
}

export function validateProtectedHeaders(
  rows: readonly ProtectedHeaderInput[],
): Record<string, string> {
  try {
    prepareConnectionHeaders(
      [],
      rows.map(({ name, value }) => [name.trim().toLowerCase(), value] as const),
    );
  } catch {
    throw new ConnectionValidationError(
      "INVALID_PROTECTED_HEADERS",
      "protected headers contain an invalid, duplicate, or forbidden header",
    );
  }
  return Object.fromEntries(rows.map(({ name, value }) => [name.trim().toLowerCase(), value]));
}
