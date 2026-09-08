import { z } from "zod";
import type { RuntimeRole } from "./runtime.js";

export const DATA_PRESETS = [
  "personal",
  "submissions",
  "contributions",
  "managed",
  "collaborative",
] as const;
export const RIGHTS = ["none", "own", "editors", "own_and_editors", "viewers"] as const;
export const DATA_OPERATIONS = ["read", "create", "update", "delete", "increment"] as const;
export type DataRight = (typeof RIGHTS)[number];
export type DataOperation = (typeof DATA_OPERATIONS)[number];
export type DataRules = Record<DataOperation, DataRight>;
export const PRESET_RULES: Record<(typeof DATA_PRESETS)[number], DataRules> = {
  personal: { read: "own", create: "viewers", update: "own", delete: "own", increment: "own" },
  submissions: {
    read: "own_and_editors",
    create: "viewers",
    update: "own_and_editors",
    delete: "own_and_editors",
    increment: "own_and_editors",
  },
  contributions: {
    read: "viewers",
    create: "viewers",
    update: "own_and_editors",
    delete: "own_and_editors",
    increment: "own_and_editors",
  },
  managed: {
    read: "viewers",
    create: "editors",
    update: "editors",
    delete: "editors",
    increment: "editors",
  },
  collaborative: {
    read: "viewers",
    create: "viewers",
    update: "viewers",
    delete: "viewers",
    increment: "viewers",
  },
};
export const resourceNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/)
  .refine((name) => name !== "prototype" && !(name in Object.prototype));
const right = z.enum(RIGHTS);
const audience = z.enum(["none", "editors", "viewers"]);
export const dataPolicySchema = z
  .object({
    preset: z.enum(DATA_PRESETS),
    overrides: z
      .object({
        read: right.optional(),
        create: audience.optional(),
        update: right.optional(),
        delete: right.optional(),
        increment: right.optional(),
      })
      .strict()
      .optional(),
    aggregateCount: audience.optional(),
  })
  .strict();
export const channelPolicySchema = z
  .object({
    subscribe: audience,
    publish: audience,
    seePresence: audience,
    participatePresence: audience,
  })
  .strict();
export type DataPolicy = z.infer<typeof dataPolicySchema>;
export type ChannelPolicy = z.infer<typeof channelPolicySchema>;
const map = <T extends z.ZodType>(value: T) =>
  z
    .record(resourceNameSchema, value)
    .refine((entries) => Object.keys(entries).length <= 50, "At most 50 resources per type");
export const runtimePolicySchema = z
  .object({
    defaultMode: z.enum(["read_only", "participation", "collaboration"]),
    collections: map(dataPolicySchema),
    fileGroups: map(dataPolicySchema),
    channels: map(channelPolicySchema),
    connections: map(
      z
        .object({
          audience,
          methods: z
            .array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]))
            .max(7)
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>;
export function emptyRuntimePolicy(): RuntimePolicy {
  return {
    defaultMode: "participation",
    collections: {},
    fileGroups: {},
    channels: {},
    connections: {},
  };
}
export function parseRuntimePolicy(raw?: string | null): RuntimePolicy {
  if (!raw) return emptyRuntimePolicy();
  // Persisted configuration is validated on write. Corruption must never widen access.
  return runtimePolicySchema.parse(JSON.parse(raw));
}
export function dataRules(policy: DataPolicy): DataRules {
  return { ...PRESET_RULES[policy.preset], ...policy.overrides };
}
/** Mutations require visibility too, matching direct and bulk runtime operations. */
export function dataPermissions(
  policy: DataPolicy,
  role: RuntimeRole,
  actor: string,
  enabled = true,
) {
  const rules = dataRules(policy);
  return Object.fromEntries(
    DATA_OPERATIONS.map((op) => [
      op,
      Object.fromEntries(
        (["own", "any"] as const).map((scope) => {
          const author = scope === "own" ? actor : undefined;
          return [
            scope,
            enabled &&
              rightAllows(rules[op], role, actor, author) &&
              (op === "read" || op === "create" || rightAllows(rules.read, role, actor, author)),
          ];
        }),
      ),
    ]),
  ) as Record<DataOperation, { own: boolean; any: boolean }>;
}
export function rightAllows(
  right: DataRight,
  role: RuntimeRole,
  actorId: string,
  authorId?: string | null,
): boolean {
  const own = authorId === actorId;
  const editor = role === "owner" || role === "editor";
  return (
    right === "viewers" ||
    (right === "own" && own) ||
    (right === "editors" && editor) ||
    (right === "own_and_editors" && (own || editor))
  );
}
/** SQL callers use null for all rows, actor id for own rows, false for no rows. */
export function authorFilter(
  right: DataRight,
  role: RuntimeRole,
  actorId: string,
): string | null | false {
  if (rightAllows(right, role, actorId)) return null;
  return rightAllows(right, role, actorId, actorId) ? actorId : false;
}
export function defaultDataPreset(mode: RuntimePolicy["defaultMode"]): DataPolicy["preset"] {
  return mode === "read_only"
    ? "managed"
    : mode === "collaboration"
      ? "collaborative"
      : "contributions";
}
export function defaultChannelPolicy(mode: RuntimePolicy["defaultMode"]): ChannelPolicy {
  return {
    subscribe: "viewers",
    publish: mode === "read_only" ? "editors" : "viewers",
    seePresence: "viewers",
    participatePresence: "viewers",
  };
}
export function channelPolicy(policy: RuntimePolicy, name: string): ChannelPolicy {
  return (
    (Object.hasOwn(policy.channels, name) ? policy.channels[name] : undefined) ?? {
      subscribe: "viewers",
      publish: name.startsWith("participants:") ? "viewers" : "editors",
      seePresence: "viewers",
      participatePresence: "viewers",
    }
  );
}
export class PolicyConflictError extends Error {
  readonly code = "POLICY_CONFLICT";
  constructor() {
    super("Permissions changed. Reload before saving again.");
  }
}
