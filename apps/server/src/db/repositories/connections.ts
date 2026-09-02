import {
  type CanvasConnection,
  type ConnectionProfile,
  pgSchema,
  sqliteSchema,
} from "@canvas-drop/shared/db";
import { and, asc, eq } from "drizzle-orm";
import type { DbClient } from "../factory.js";

export const CONNECTION_KEY_UNIQUE = {
  pgConstraint: "connection_profiles_key_uq",
  sqliteColumn: "connection_profiles.key",
};

export interface GrantedConnectionRow {
  profile: ConnectionProfile;
  grant: CanvasConnection;
}

export interface GrantedCanvasSummary {
  id: string;
  slug: string;
  title: string;
}

/** Dual-dialect persistence for reusable profiles and explicit canvas grants. */
export function connectionsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect Drizzle seam
  const db = client.db as any;
  const S = client.dialect === "sqlite" ? sqliteSchema : pgSchema;
  const profiles = S.connectionProfiles;
  const grants = S.canvasConnections;
  const canvases = S.canvases;

  async function countGrants(connectionId: string): Promise<number> {
    const rows = (await db
      .select({ canvasId: grants.canvasId })
      .from(grants)
      .where(eq(grants.connectionId, connectionId))) as Array<{ canvasId: string }>;
    return rows.length;
  }

  return {
    async create(profile: ConnectionProfile): Promise<ConnectionProfile> {
      const rows = (await db.insert(profiles).values(profile).returning()) as ConnectionProfile[];
      return rows[0] as ConnectionProfile;
    },

    async findById(id: string): Promise<ConnectionProfile | null> {
      const rows = (await db
        .select()
        .from(profiles)
        .where(eq(profiles.id, id))
        .limit(1)) as ConnectionProfile[];
      return rows[0] ?? null;
    },

    async findByKey(key: string): Promise<ConnectionProfile | null> {
      const rows = (await db
        .select()
        .from(profiles)
        .where(eq(profiles.key, key))
        .limit(1)) as ConnectionProfile[];
      return rows[0] ?? null;
    },

    async list(): Promise<ConnectionProfile[]> {
      return (await db.select().from(profiles).orderBy(asc(profiles.key))) as ConnectionProfile[];
    },

    async update(
      id: string,
      patch: Partial<
        Pick<
          ConnectionProfile,
          | "label"
          | "origin"
          | "allowedMethods"
          | "protectedHeaderNames"
          | "protectedHeadersEnvelope"
          | "enabled"
          | "updatedAt"
        >
      >,
    ): Promise<ConnectionProfile | null> {
      const rows = (await db
        .update(profiles)
        .set(patch)
        .where(eq(profiles.id, id))
        .returning()) as ConnectionProfile[];
      return rows[0] ?? null;
    },

    /** One atomic DELETE; FK cascade revokes every canvas grant in the same statement. */
    async delete(id: string): Promise<{ deleted: boolean; revokedGrants: number }> {
      const revokedGrants = await countGrants(id);
      const rows = (await db
        .delete(profiles)
        .where(eq(profiles.id, id))
        .returning({ id: profiles.id })) as Array<{ id: string }>;
      return { deleted: rows.length === 1, revokedGrants: rows.length === 1 ? revokedGrants : 0 };
    },

    countGrants,

    async attach(grant: CanvasConnection): Promise<boolean> {
      const rows = (await db
        .insert(grants)
        .values(grant)
        .onConflictDoNothing()
        .returning({ canvasId: grants.canvasId })) as Array<{ canvasId: string }>;
      return rows.length === 1;
    },

    async detach(connectionId: string, canvasId: string): Promise<boolean> {
      const rows = (await db
        .delete(grants)
        .where(and(eq(grants.connectionId, connectionId), eq(grants.canvasId, canvasId)))
        .returning({ canvasId: grants.canvasId })) as Array<{ canvasId: string }>;
      return rows.length === 1;
    },

    async listForCanvas(canvasId: string): Promise<GrantedConnectionRow[]> {
      const rows = (await db
        .select({ profile: profiles, grant: grants })
        .from(grants)
        .innerJoin(profiles, eq(grants.connectionId, profiles.id))
        .where(eq(grants.canvasId, canvasId))
        .orderBy(asc(profiles.key))) as GrantedConnectionRow[];
      return rows;
    },

    async findGranted(canvasId: string, key: string): Promise<GrantedConnectionRow | null> {
      const rows = (await db
        .select({ profile: profiles, grant: grants })
        .from(grants)
        .innerJoin(profiles, eq(grants.connectionId, profiles.id))
        .where(and(eq(grants.canvasId, canvasId), eq(profiles.key, key)))
        .limit(1)) as GrantedConnectionRow[];
      return rows[0] ?? null;
    },

    async listCanvases(connectionId: string): Promise<GrantedCanvasSummary[]> {
      return (await db
        .select({ id: canvases.id, slug: canvases.slug, title: canvases.title })
        .from(grants)
        .innerJoin(canvases, eq(grants.canvasId, canvases.id))
        .where(eq(grants.connectionId, connectionId))
        .orderBy(asc(canvases.slug))) as GrantedCanvasSummary[];
    },
  };
}

export type ConnectionsRepository = ReturnType<typeof connectionsRepository>;
