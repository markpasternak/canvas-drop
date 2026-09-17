import type { ConnectionMethod, PublicConnectionPolicy } from "@canvas-drop/shared/db";
import { z } from "zod";
import { CONNECTION_METHODS, ConnectionValidationError } from "./validation.js";

export function isPublicConnectionPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/[\\%?#\s]/.test(path) &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    new URL(path, "https://connection.invalid").pathname === path
  );
}

const publicPolicySchema = z
  .object({
    paths: z.array(z.string().min(1).max(2048).refine(isPublicConnectionPath)).min(1).max(16),
    methods: z.array(z.enum(CONNECTION_METHODS)).min(1).max(6),
    requestsPerDay: z.number().int().min(1).max(1_000_000),
  })
  .strict();

export function validatePublicPolicy(
  input: unknown,
  allowedMethods: ConnectionMethod[],
): PublicConnectionPolicy | null {
  if (input === null) return null;
  const parsed = publicPolicySchema.safeParse(input);
  if (!parsed.success || parsed.data.methods.some((method) => !allowedMethods.includes(method))) {
    throw new ConnectionValidationError(
      "INVALID_PROFILE",
      "Public access needs exact paths, allowed methods, and a daily request cap between 1 and 1,000,000.",
    );
  }
  return {
    ...parsed.data,
    paths: [...new Set(parsed.data.paths)],
    methods: [...new Set(parsed.data.methods)],
  };
}
