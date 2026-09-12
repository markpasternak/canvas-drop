import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { DeployError } from "./errors.js";
import {
  awaitHolder,
  classifyPublication,
  currentPublication,
  IN_FLIGHT_WINDOW_MS,
  normalizeCoordination,
  validateReleaseId,
} from "./publication.js";

describe("validateReleaseId / normalizeCoordination", () => {
  it("accepts 1–200 printable characters and returns undefined for an absent value", () => {
    expect(validateReleaseId(undefined)).toBeUndefined();
    expect(validateReleaseId(null)).toBeUndefined();
    expect(validateReleaseId("gh:acme/roadmap@3f9c2e1:prod")).toBe("gh:acme/roadmap@3f9c2e1:prod");
    expect(validateReleaseId("x".repeat(200))).toBe("x".repeat(200));
    expect(validateReleaseId("släpp ✓")).toBe("släpp ✓"); // opaque: any printable text
  });

  it("rejects empty, over-long, control-character and non-string values with INVALID_RELEASE_ID", () => {
    for (const bad of ["", "x".repeat(201), "a\nb", "tab\there", 42, {}]) {
      let caught: unknown;
      try {
        validateReleaseId(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DeployError);
      expect((caught as DeployError).code).toBe("INVALID_RELEASE_ID");
    }
  });

  it("normalizeCoordination validates the release and passes any supplied token through verbatim", () => {
    expect(normalizeCoordination(undefined)).toEqual({});
    expect(normalizeCoordination({})).toEqual({});
    expect(
      normalizeCoordination({ releaseId: "r1", expectedPublicationToken: "not-even-hex" }),
    ).toEqual({ releaseId: "r1", expectedPublicationToken: "not-even-hex" });
    expect(normalizeCoordination({ releaseId: null, expectedPublicationToken: null })).toEqual({});
  });
});

describe.each(DIALECTS)("classifyPublication / awaitHolder [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function setup() {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const ready = async (number: number, releaseId?: string) => {
      const v = await versions.createPending({
        canvasId: cv.id,
        number,
        createdBy: owner.id,
        source: "api",
        releaseId,
      });
      return versions.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: {} });
    };
    return { canvases, versions, cv, ready, deps: { canvases, versions } };
  }

  it("reports absent, release_not_current and already_current from the live rows", async () => {
    const { canvases, cv, ready, deps } = await setup();
    expect((await classifyPublication(deps, cv.id, "R")).kind).toBe("absent");
    const v1 = await ready(1, "R");
    const notCurrent = await classifyPublication(deps, cv.id, "R");
    expect(notCurrent.kind).toBe("release_not_current");
    if (notCurrent.kind === "release_not_current") expect(notCurrent.holder.id).toBe(v1.id);
    await canvases.setCurrentVersion(cv.id, v1.id);
    const current = await classifyPublication(deps, cv.id, "R");
    expect(current.kind).toBe("already_current");
    if (current.kind === "already_current") expect(current.current.id).toBe(v1.id);
    // A pending row carrying the release is not a holder.
    expect((await classifyPublication(deps, cv.id, "S")).kind).toBe("absent");
  });

  it("currentPublication carries the token and the current version's identity (null when unpublished)", async () => {
    const { canvases, cv, ready, deps } = await setup();
    const before = await currentPublication(deps, cv.id);
    expect(before).toEqual({
      publicationToken: cv.publicationToken,
      versionId: null,
      version: null,
      releaseId: null,
    });
    const v1 = await ready(1, "R");
    const token = await canvases.activateVersion(cv.id, v1.id, {});
    expect(await currentPublication(deps, cv.id)).toEqual({
      publicationToken: token,
      versionId: v1.id,
      version: 1,
      releaseId: "R",
    });
  });

  it("awaitHolder waits on an in-flight holder, returns already_current once it lands, and never sleeps for a historical one", async () => {
    const { canvases, cv, ready, deps } = await setup();
    const v1 = await ready(1);
    await canvases.setCurrentVersion(cv.id, v1.id);
    const v2 = await ready(2, "R"); // ready, newer than current → looks in flight
    let sleeps = 0;
    const sleep = async () => {
      sleeps++;
      if (sleeps === 2) await canvases.setCurrentVersion(cv.id, v2.id); // the winner lands
    };
    const result = await awaitHolder(deps, cv.id, "R", { attempts: 5, sleep });
    expect(result.classification.kind).toBe("already_current");
    expect(result.timedOut).toBe(false);
    expect(sleeps).toBe(2);

    // A holder created outside the in-flight window is history, not a race: no sleep.
    const v3 = await ready(3);
    await canvases.setCurrentVersion(cv.id, v3.id);
    let slept = false;
    const hist = await awaitHolder(deps, cv.id, "R", {
      attempts: 5,
      now: () => Date.now() + 2 * IN_FLIGHT_WINDOW_MS,
      sleep: async () => {
        slept = true;
      },
    });
    expect(hist.classification.kind).toBe("release_not_current");
    expect(hist.timedOut).toBe(false);
    expect(slept).toBe(false);
  });

  it("awaitHolder times out on a holder that never lands and reports absent when the holder disappears", async () => {
    const { versions, cv, ready, deps } = await setup();
    const holder = await ready(1, "R"); // ready, no current version → in flight
    let sleeps = 0;
    const timedOut = await awaitHolder(deps, cv.id, "R", {
      attempts: 3,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(timedOut.classification.kind).toBe("release_not_current");
    expect(timedOut.timedOut).toBe(true);
    expect(sleeps).toBe(3);

    const gone = await awaitHolder(deps, cv.id, "R", {
      attempts: 3,
      sleep: async () => {
        await versions.deleteReadyNonCurrentById(cv.id, holder.id); // the winner withdrew
      },
    });
    expect(gone.classification.kind).toBe("absent");
    expect(gone.timedOut).toBe(false);
  });
});
