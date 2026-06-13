import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { createAuditLog } from "./audit-log.js";

const silent = pino({ level: "silent" });

describe.each(DIALECTS)("auditLog [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("appends a row with actor, action, ip, and an epoch-ms timestamp", async () => {
    client = await makeTestDb(dialect);
    const audit = createAuditLog(auditRepository(client), silent);
    const before = Date.now();
    audit.recordAudit({ actorId: "u1", action: "session_create", ip: "127.0.0.1" });
    await audit.flush();

    const rows = await auditRepository(client).recent();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("session_create");
    expect(rows[0].actorId).toBe("u1");
    expect(rows[0].ip).toBe("127.0.0.1");
    expect(typeof rows[0].createdAt).toBe("number");
    expect(rows[0].createdAt).toBeGreaterThanOrEqual(before);
  });

  it("records auth_denied (domain) with the rejected email in meta", async () => {
    client = await makeTestDb(dialect);
    const audit = createAuditLog(auditRepository(client), silent);
    audit.record({ action: "auth_denied", reason: "domain_not_allowed", email: "x@evil.org" });
    await audit.flush();

    const rows = await auditRepository(client).recent();
    expect(rows[0].action).toBe("auth_denied");
    expect(rows[0].meta).toMatchObject({ reason: "domain_not_allowed", email: "x@evil.org" });
  });

  it("folds the correlation id into meta", async () => {
    client = await makeTestDb(dialect);
    const audit = createAuditLog(auditRepository(client), silent);
    audit.recordAudit({ action: "auth_ok", actorId: "u1", correlationId: "corr-9" });
    await audit.flush();

    const rows = await auditRepository(client).recent();
    expect(rows[0].meta).toMatchObject({ correlationId: "corr-9" });
  });

  it("swallows a write failure without throwing into the caller", async () => {
    client = await makeTestDb(dialect);
    // a repo whose append always rejects
    const brokenRepo = {
      append: () => Promise.reject(new Error("db down")),
      recent: async () => [],
    };
    const audit = createAuditLog(brokenRepo, silent);
    expect(() => audit.recordAudit({ action: "auth_ok", actorId: "u1" })).not.toThrow();
    await expect(audit.flush()).resolves.toBeUndefined();
  });
});
