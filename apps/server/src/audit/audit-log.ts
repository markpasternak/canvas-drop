import type { Json } from "@canvas-drop/shared/db";
import type { AuthEvent, AuthEventSink } from "../auth/gateway.js";
import type { AuditRepository } from "../db/repositories/audit.js";
import type { Logger } from "../log/logger.js";

export interface RecordAuditInput {
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Json;
  ip?: string | null;
  /** Correlation id from the request (U3), folded into `meta`. */
  correlationId?: string;
}

/**
 * Audit log service (§6.11.1, §12.1.8). Writes are best-effort and must never
 * block or fail the request path — a write failure is logged and swallowed.
 * Implements {@link AuthEventSink} so the auth gateway (U7) records auth events.
 */
export interface AuditLog extends AuthEventSink {
  recordAudit(input: RecordAuditInput): void;
  /** Await all in-flight writes (tests, graceful shutdown). */
  flush(): Promise<void>;
}

export function createAuditLog(repo: AuditRepository, log: Logger): AuditLog {
  const pending = new Set<Promise<void>>();

  const write = (input: RecordAuditInput): void => {
    const meta = mergeMeta(input.meta, input.correlationId);
    // fire-and-forget; never block or throw into the request path
    const p = repo
      .append({
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        meta,
        ip: input.ip,
      })
      .catch((err) => log.error({ err, action: input.action }, "audit write failed"))
      .finally(() => pending.delete(p));
    pending.add(p);
  };

  return {
    recordAudit: write,
    async flush() {
      await Promise.all([...pending]);
    },
    record(event: AuthEvent) {
      write({
        action: event.action,
        actorId: event.actorId,
        ip: event.ip,
        meta: metaForAuthEvent(event),
      });
    },
  };
}

function metaForAuthEvent(event: AuthEvent): Json {
  const meta: Record<string, Json> = {};
  if (event.reason) meta.reason = event.reason;
  if (event.email) meta.email = event.email;
  return meta;
}

function mergeMeta(meta: Json | undefined, correlationId?: string): Json {
  if (!correlationId) return meta ?? null;
  const base = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  return { ...base, correlationId };
}
