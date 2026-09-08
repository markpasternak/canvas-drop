/** Browser wire types; server policy validation and authorization remain authoritative. */
export type Audience = "none" | "editors" | "viewers";
export type Right = Audience | "own" | "own_and_editors";
export type Preset = "personal" | "submissions" | "contributions" | "managed" | "collaborative";
export type Operation = "read" | "create" | "update" | "delete" | "increment";
export interface DataPolicy {
  preset: Preset;
  overrides?: Partial<Record<Operation, Right>>;
  aggregateCount?: Audience;
}
export interface ChannelPolicy {
  subscribe: Audience;
  publish: Audience;
  seePresence: Audience;
  participatePresence: Audience;
}
export interface RuntimePolicy {
  defaultMode: "read_only" | "participation" | "collaboration";
  collections: Record<string, DataPolicy>;
  fileGroups: Record<string, DataPolicy>;
  channels: Record<string, ChannelPolicy>;
  connections: Record<string, { audience: Audience; methods?: string[] }>;
}
export const PRESETS: Record<
  Preset,
  { label: string; summary: string; rules: Record<Operation, Right> }
> = {
  personal: {
    label: "Personal",
    summary: "Only the author can read or change their items.",
    rules: { read: "own", create: "viewers", update: "own", delete: "own", increment: "own" },
  },
  submissions: {
    label: "Private submissions",
    summary: "Authors and owners/editors can read and manage submissions.",
    rules: {
      read: "own_and_editors",
      create: "viewers",
      update: "own_and_editors",
      delete: "own_and_editors",
      increment: "own_and_editors",
    },
  },
  contributions: {
    label: "Shared contributions",
    summary:
      "Everyone can contribute. Authors and owners/editors can change or delete their items.",
    rules: {
      read: "viewers",
      create: "viewers",
      update: "own_and_editors",
      delete: "own_and_editors",
      increment: "own_and_editors",
    },
  },
  managed: {
    label: "Managed content",
    summary: "Everyone can read. Only owners and editors can change content.",
    rules: {
      read: "viewers",
      create: "editors",
      update: "editors",
      delete: "editors",
      increment: "editors",
    },
  },
  collaborative: {
    label: "Collaborative content",
    summary: "Everyone can read, create, change and delete any item.",
    rules: {
      read: "viewers",
      create: "viewers",
      update: "viewers",
      delete: "viewers",
      increment: "viewers",
    },
  },
};
export const RIGHT_LABELS: Record<Right, string> = {
  none: "Nobody",
  own: "Author only",
  editors: "Owners and editors",
  own_and_editors: "Author, owners and editors",
  viewers: "All participants",
};
export function emptyPolicy(): RuntimePolicy {
  return {
    defaultMode: "participation",
    collections: {},
    fileGroups: {},
    channels: {},
    connections: {},
  };
}
export function defaultPreset(mode: RuntimePolicy["defaultMode"]): Preset {
  return mode === "read_only"
    ? "managed"
    : mode === "collaboration"
      ? "collaborative"
      : "contributions";
}
