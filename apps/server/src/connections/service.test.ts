import { randomBytes } from "node:crypto";
import type { Json } from "@canvas-drop/shared/db";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditLog, RecordAuditInput } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { connectionsRepository } from "../db/repositories/connections.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { createSecretCipher } from "./secret-cipher.js";
import { connectionService } from "./service.js";

function auditSpy() {
  const events: RecordAuditInput[] = [];
  const audit: AuditLog = {
    recordAudit: (event) => events.push(event),
    record: (event) => events.push(event as unknown as RecordAuditInput),
    flush: async () => {},
  };
  return { audit, events };
}

describe.each(DIALECTS)("connectionService [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => client?.close());

  async function fixture(withKey = true) {
    client = await makeTestDb(dialect);
    const admin = await usersRepository(client).upsert({
      providerSub: "admin",
      email: "admin@example.com",
      name: "Admin",
      isAdmin: true,
    });
    const canvases = canvasesRepository(client);
    const canvas = await canvases.create({
      ownerId: admin.id,
      slug: "stocks-1111-2222",
      apiKeyHash: "hash",
    });
    const repository = connectionsRepository(client);
    const { audit, events } = auditSpy();
    const cipher = createSecretCipher(withKey ? randomBytes(32).toString("base64") : undefined);
    const service = connectionService({ repository, canvases, cipher, audit });
    return { admin, canvas, repository, service, events };
  }

  it("creates a sanitized stock profile and never projects protected values", async () => {
    const { admin, service, events } = await fixture();
    const view = await service.create(admin.id, {
      key: "stocks",
      label: "Stock data",
      origin: "https://stocks.example.com",
      allowedMethods: ["get"],
      protectedHeaders: [{ name: "User-Agent", value: "canvas-drop-controlled-agent" }],
    });

    expect(view).toMatchObject({
      key: "stocks",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
      protectedHeaders: [{ name: "user-agent", set: true }],
      affectedCanvasCount: 0,
    });
    expect(JSON.stringify(view)).not.toContain("canvas-drop-controlled-agent");
    expect(JSON.stringify(events)).not.toContain("canvas-drop-controlled-agent");
  });

  it("preserves, replaces, and explicitly clears the encrypted header map", async () => {
    const { admin, repository, service } = await fixture();
    const created = await service.create(admin.id, {
      key: "stocks",
      label: "Stocks",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
      protectedHeaders: [{ name: "Authorization", value: "Bearer first" }],
    });
    const before = await repository.findById(created.id);
    await service.update(admin.id, created.id, { label: "Market data" });
    expect((await repository.findById(created.id))?.protectedHeadersEnvelope).toBe(
      before?.protectedHeadersEnvelope,
    );
    await service.update(admin.id, created.id, {
      protectedHeaders: [{ name: "Authorization", value: "Bearer second" }],
    });
    expect((await repository.findById(created.id))?.protectedHeadersEnvelope).not.toBe(
      before?.protectedHeadersEnvelope,
    );
    const cleared = await service.update(admin.id, created.id, { protectedHeaders: [] });
    expect(cleared.protectedHeaders).toEqual([]);
    expect((await repository.findById(created.id))?.protectedHeadersEnvelope).toBeNull();
  });

  it("makes grants idempotent and requires an exact delete blast-radius confirmation", async () => {
    const { admin, canvas, repository, service } = await fixture();
    const profile = await service.create(admin.id, {
      key: "stocks",
      label: "Stocks",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
    });
    await expect(service.attach(admin.id, profile.id, canvas.id)).resolves.toMatchObject({
      attached: true,
    });
    await expect(service.attach(admin.id, profile.id, canvas.id)).resolves.toMatchObject({
      attached: false,
    });
    await expect(service.remove(admin.id, profile.id, 0)).rejects.toMatchObject({
      code: "CONNECTION_CONFIRMATION_REQUIRED",
    });
    await expect(service.remove(admin.id, profile.id, 1)).resolves.toEqual({
      deleted: true,
      revokedGrants: 1,
    });
    await expect(repository.findGranted(canvas.id, "stocks")).resolves.toBeNull();
  });

  it("serializes attach against a confirmed profile deletion", async () => {
    const { admin, canvas, repository, service } = await fixture();
    const profile = await service.create(admin.id, {
      key: "stocks",
      label: "Stocks",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
    });
    await service.attach(admin.id, profile.id, canvas.id);

    const originalCountGrants = repository.countGrants;
    let releaseCount = () => {};
    const countBlocked = new Promise<void>((resolve) => {
      releaseCount = resolve;
    });
    let countStarted = () => {};
    const countEntered = new Promise<void>((resolve) => {
      countStarted = resolve;
    });
    repository.countGrants = async (id) => {
      const count = await originalCountGrants(id);
      countStarted();
      await countBlocked;
      return count;
    };

    const removal = service.remove(admin.id, profile.id, 1);
    await countEntered;
    const concurrentAttach = service.attach(admin.id, profile.id, canvas.id);
    releaseCount();

    await expect(removal).resolves.toEqual({ deleted: true, revokedGrants: 1 });
    await expect(concurrentAttach).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
  });

  it("shows missing-key availability without decrypting or revealing header names to managers", async () => {
    const seeded = await fixture(true);
    const profile = await seeded.service.create(seeded.admin.id, {
      key: "stocks",
      label: "Stocks",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
      protectedHeaders: [{ name: "User-Agent", value: "secret-agent" }],
    });
    await seeded.service.attach(seeded.admin.id, profile.id, seeded.canvas.id);
    const { audit } = auditSpy();
    const withoutKey = connectionService({
      repository: seeded.repository,
      canvases: canvasesRepository(client),
      cipher: createSecretCipher(undefined),
      audit,
    });

    const [adminView] = await withoutKey.listAdmin();
    const [managerView] = await withoutKey.listForCanvas(seeded.canvas.id);
    expect(adminView).toMatchObject({
      protectedHeaders: [{ name: "user-agent", set: true }],
      encryptionKeyAvailable: false,
    });
    expect(managerView).toEqual({
      key: "stocks",
      label: "Stocks",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
      available: false,
      unavailableReason: "encryption_key_unavailable",
    });
    const serialized = JSON.stringify(managerView) as Json;
    expect(serialized).not.toContain("user-agent");
    expect(serialized).not.toContain("secret-agent");
  });

  it.each([
    { key: "Bad Key", origin: "https://stocks.example.com", methods: ["GET"] },
    { key: "api", origin: "https://stocks.example.com", methods: ["GET"] },
    { key: "stocks", origin: "http://stocks.example.com", methods: ["GET"] },
    { key: "stocks", origin: "https://127.0.0.1", methods: ["GET"] },
    { key: "stocks", origin: "https://stocks.example.com/path", methods: ["GET"] },
    { key: "stocks", origin: "https://stocks.example.com", methods: ["OPTIONS"] },
    { key: "stocks", origin: "https://stocks.example.com", methods: [] },
  ])("rejects an invalid profile before persistence: $key $origin $methods", async (input) => {
    const { admin, repository, service } = await fixture();
    await expect(
      service.create(admin.id, {
        key: input.key,
        label: "Stocks",
        origin: input.origin,
        allowedMethods: input.methods,
      }),
    ).rejects.toThrow();
    await expect(repository.list()).resolves.toEqual([]);
  });
});
