import { type McpToken, type OauthCode, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { and, eq, gt, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";
import { hashToken } from "./sessions.js";

export interface CreateCodeInput {
  /** Raw authorization code; only its hash is persisted. */
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod?: string | null;
  scopes?: string[] | null;
  resource?: string | null;
  expiresAt: number;
}

export interface CreateTokenInput {
  /** Raw token; only its hash is persisted. */
  token: string;
  kind: "access" | "refresh";
  clientId: string;
  userId: string;
  scopes?: string[] | null;
  /** Access tokens expire; refresh tokens may be long-lived (`null`). */
  expiresAt?: number | null;
}

/**
 * Persistence for the remote MCP OAuth authorization server (U2). Three concerns
 * with distinct lifecycles — DCR client registrations, single-use authorization
 * codes, and hashed access/refresh tokens — behind one repo. Mirrors the
 * sessions repository: only hashes are stored (§12.1.3), dual-dialect seam typed
 * `any` exactly as in {@link sessionsRepository}.
 */
export function oauthRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const s = client.dialect === "sqlite" ? sqliteSchema : pgSchema;
  const clientsT = s.oauthClients;
  const codesT = s.oauthCodes;
  const tokensT = s.mcpTokens;

  return {
    clients: {
      /** Persist a DCR registration, round-tripping the full client info blob. */
      async upsert(info: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
        const existing = await db
          .select()
          .from(clientsT)
          .where(eq(clientsT.id, info.client_id))
          .limit(1);
        if (existing[0]) {
          await db
            .update(clientsT)
            .set({ clientInfo: info })
            .where(eq(clientsT.id, info.client_id));
        } else {
          await db
            .insert(clientsT)
            .values({ id: info.client_id, clientInfo: info, createdAt: Date.now() });
        }
        return info;
      },

      async get(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        const rows = await db.select().from(clientsT).where(eq(clientsT.id, clientId)).limit(1);
        return (rows[0]?.clientInfo as OAuthClientInformationFull | undefined) ?? undefined;
      },
    },

    codes: {
      async create(input: CreateCodeInput): Promise<void> {
        await db.insert(codesT).values({
          id: uuidv7(),
          codeHash: hashToken(input.code),
          clientId: input.clientId,
          userId: input.userId,
          redirectUri: input.redirectUri,
          codeChallenge: input.codeChallenge,
          codeChallengeMethod: input.codeChallengeMethod ?? null,
          scopes: input.scopes ?? null,
          resource: input.resource ?? null,
          expiresAt: input.expiresAt,
          consumedAt: null,
          createdAt: Date.now(),
        });
      },

      /** Live = exists, not consumed, not expired. Read-only — does NOT consume. */
      async findLive(code: string, now: number = Date.now()): Promise<OauthCode | null> {
        const rows = await db
          .select()
          .from(codesT)
          .where(
            and(
              eq(codesT.codeHash, hashToken(code)),
              isNull(codesT.consumedAt),
              gt(codesT.expiresAt, now),
            ),
          )
          .limit(1);
        return (rows[0] as OauthCode | undefined) ?? null;
      },

      /**
       * Atomically consume a live code. The conditional UPDATE…RETURNING makes
       * consumption single-use even under concurrency: only the call whose UPDATE
       * matches the still-unconsumed row gets a row back; a replay gets null.
       */
      async consume(code: string, now: number = Date.now()): Promise<OauthCode | null> {
        const updated = await db
          .update(codesT)
          .set({ consumedAt: now })
          .where(
            and(
              eq(codesT.codeHash, hashToken(code)),
              isNull(codesT.consumedAt),
              gt(codesT.expiresAt, now),
            ),
          )
          .returning();
        return (updated[0] as OauthCode | undefined) ?? null;
      },
    },

    tokens: {
      async create(input: CreateTokenInput): Promise<void> {
        await db.insert(tokensT).values({
          id: uuidv7(),
          tokenHash: hashToken(input.token),
          kind: input.kind,
          clientId: input.clientId,
          userId: input.userId,
          scopes: input.scopes ?? null,
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
          createdAt: Date.now(),
        });
      },

      /** Live = exists, not revoked, and (for access tokens) not expired. */
      async findLive(
        token: string,
        kind?: "access" | "refresh",
        now: number = Date.now(),
      ): Promise<McpToken | null> {
        const conds = [eq(tokensT.tokenHash, hashToken(token)), isNull(tokensT.revokedAt)];
        if (kind) conds.push(eq(tokensT.kind, kind));
        const rows = await db
          .select()
          .from(tokensT)
          .where(and(...conds))
          .limit(1);
        const row = rows[0] as McpToken | undefined;
        if (!row) return null;
        if (row.expiresAt != null && row.expiresAt <= now) return null;
        return row;
      },

      async revoke(token: string): Promise<void> {
        await db
          .update(tokensT)
          .set({ revokedAt: Date.now() })
          .where(eq(tokensT.tokenHash, hashToken(token)));
      },

      /**
       * Atomically revoke a live token and return it — single-use, even under
       * concurrency. Like {@link codes.consume}, only the call whose conditional
       * UPDATE matches the still-live row gets a row back; a concurrent reuse gets
       * null. Used for refresh-token rotation so one refresh token mints one pair.
       */
      async consume(
        token: string,
        kind: "access" | "refresh",
        now: number = Date.now(),
      ): Promise<McpToken | null> {
        const updated = await db
          .update(tokensT)
          .set({ revokedAt: now })
          .where(
            and(
              eq(tokensT.tokenHash, hashToken(token)),
              eq(tokensT.kind, kind),
              isNull(tokensT.revokedAt),
            ),
          )
          .returning();
        const row = updated[0] as McpToken | undefined;
        if (!row) return null;
        if (row.expiresAt != null && row.expiresAt <= now) return null;
        return row;
      },

      async revokeAllForUser(userId: string): Promise<void> {
        await db
          .update(tokensT)
          .set({ revokedAt: Date.now() })
          .where(and(eq(tokensT.userId, userId), isNull(tokensT.revokedAt)));
      },
    },
  };
}

export type OauthRepository = ReturnType<typeof oauthRepository>;
