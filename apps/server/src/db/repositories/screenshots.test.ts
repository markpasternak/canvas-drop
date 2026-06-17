import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { screenshotsRepository } from "./screenshots.js";
import { usersRepository } from "./users.js";

const V1 = "0190b000-0000-7000-8000-0000000000a1";
const V2 = "0190b000-0000-7000-8000-0000000000a2";

/** Assert a claim returned a row and hand back its id (claimNext is `| null`). */
const idOf = (job: { id: string } | null): string => {
  if (!job) throw new Error("expected a claimed job");
  return job.id;
};

/** The claimed row's lease stamp — the completion methods are lease-guarded. */
const leaseOf = (job: { leasedAt: number | null } | null): number => {
  if (!job || job.leasedAt == null) throw new Error("expected a leased job");
  return job.leasedAt;
};

describe.each(DIALECTS)("screenshotsRepository (%s)", (dialect) => {
  let client: DbClient;
  let jobs: ReturnType<typeof screenshotsRepository>;
  let canvasId: string;

  beforeEach(async () => {
    client = await makeTestDb(dialect);
    jobs = screenshotsRepository(client);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const user = await users.upsert({
      providerSub: "p|1",
      email: "o@example.com",
      name: "Owner",
      avatarUrl: null,
      isAdmin: false,
    });
    const canvas = await canvases.create({
      slug: "quiet-otter-x7k2",
      ownerId: user.id,
      apiKeyHash: "kh",
    });
    canvasId = canvas.id;
  });

  afterEach(async () => {
    await client.close();
  });

  it("enqueue inserts a pending job for the version", async () => {
    await jobs.enqueue(canvasId, V1);
    const job = await jobs.findByCanvas(canvasId);
    expect(job?.status).toBe("pending");
    expect(job?.versionId).toBe(V1);
    expect(job?.attempts).toBe(0);
    expect(job?.leasedAt).toBeNull();
  });

  it("enqueue coalesces to the latest version (one active row per canvas)", async () => {
    await jobs.enqueue(canvasId, V1);
    const first = await jobs.findByCanvas(canvasId);
    await jobs.enqueue(canvasId, V2);
    const second = await jobs.findByCanvas(canvasId);
    // Same row id (upsert, not a second row), now pointing at the newer version.
    expect(second?.id).toBe(first?.id);
    expect(second?.versionId).toBe(V2);
    expect(second?.status).toBe("pending");
  });

  it("re-enqueue resets a failed/done row back to pending with attempts cleared", async () => {
    await jobs.enqueue(canvasId, V1);
    const claimed = await jobs.claimNext(Date.now(), Date.now() - 1000);
    await jobs.markFailedOrRetry(idOf(claimed), "boom", 1, leaseOf(claimed)); // attempts (1) >= max (1) → failed
    expect((await jobs.findByCanvas(canvasId))?.status).toBe("failed");

    await jobs.enqueue(canvasId, V2);
    const reset = await jobs.findByCanvas(canvasId);
    expect(reset?.status).toBe("pending");
    expect(reset?.versionId).toBe(V2);
    expect(reset?.attempts).toBe(0);
    expect(reset?.lastError).toBeNull();
  });

  it("claimNext returns and marks the oldest pending running, bumping attempts", async () => {
    await jobs.enqueue(canvasId, V1);
    const now = Date.now();
    const claimed = await jobs.claimNext(now, now - 30_000);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leasedAt).toBe(now);
  });

  it("claimNext returns null when nothing is claimable", async () => {
    expect(await jobs.claimNext(Date.now(), Date.now() - 30_000)).toBeNull();
    await jobs.enqueue(canvasId, V1);
    await jobs.claimNext(Date.now(), Date.now() - 30_000); // claim it
    // The only row is now running with a fresh lease → not claimable.
    expect(await jobs.claimNext(Date.now(), Date.now() - 30_000)).toBeNull();
  });

  it("claimNext reclaims a running row whose lease has expired", async () => {
    await jobs.enqueue(canvasId, V1);
    const t0 = 1_000_000;
    await jobs.claimNext(t0, t0 - 30_000); // running, leasedAt = t0
    // A later tick with staleBefore past the lease reclaims + re-runs it.
    const reclaimed = await jobs.claimNext(t0 + 60_000, t0 + 60_000 - 30_000);
    expect(reclaimed?.status).toBe("running");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("markDone marks the job done and clears the lease", async () => {
    await jobs.enqueue(canvasId, V1);
    const claimed = await jobs.claimNext(Date.now(), Date.now() - 30_000);
    await jobs.markDone(idOf(claimed), leaseOf(claimed));
    const done = await jobs.findByCanvas(canvasId);
    expect(done?.status).toBe("done");
    expect(done?.leasedAt).toBeNull();
  });

  it("markFailedOrRetry retries below the cap, fails at the cap", async () => {
    await jobs.enqueue(canvasId, V1);
    const now = Date.now();
    const first = await jobs.claimNext(now, now - 30_000); // attempts = 1
    await jobs.markFailedOrRetry(idOf(first), "err1", 2, leaseOf(first)); // 1 < 2 → pending
    expect((await jobs.findByCanvas(canvasId))?.status).toBe("pending");
    expect((await jobs.findByCanvas(canvasId))?.lastError).toBe("err1");

    const second = await jobs.claimNext(now, now - 30_000); // attempts = 2
    await jobs.markFailedOrRetry(idOf(second), "err2", 2, leaseOf(second)); // 2 >= 2 → failed
    expect((await jobs.findByCanvas(canvasId))?.status).toBe("failed");
  });

  it("reclaimStuck moves expired-lease running rows back to pending", async () => {
    await jobs.enqueue(canvasId, V1);
    const t0 = 1_000_000;
    await jobs.claimNext(t0, t0 - 30_000); // running, leasedAt = t0
    await jobs.reclaimStuck(t0 + 60_000); // staleBefore well past the lease
    expect((await jobs.findByCanvas(canvasId))?.status).toBe("pending");
    expect((await jobs.findByCanvas(canvasId))?.leasedAt).toBeNull();
  });

  it("reclaimStuck leaves a fresh-lease running row alone", async () => {
    await jobs.enqueue(canvasId, V1);
    const t0 = 1_000_000;
    await jobs.claimNext(t0, t0 - 30_000);
    await jobs.reclaimStuck(t0 - 30_000); // staleBefore before the lease → no reclaim
    expect((await jobs.findByCanvas(canvasId))?.status).toBe("running");
  });

  it("sweepFailed deletes failed rows past the cutoff, keeps fresh ones", async () => {
    await jobs.enqueue(canvasId, V1);
    const claimed = await jobs.claimNext(Date.now(), Date.now() - 1000);
    await jobs.markFailedOrRetry(idOf(claimed), "boom", 1, leaseOf(claimed)); // failed, updatedAt ~ now
    await jobs.sweepFailed(Date.now() - 60_000); // cutoff in the past → keep
    expect(await jobs.findByCanvas(canvasId)).not.toBeNull();
    await jobs.sweepFailed(Date.now() + 60_000); // cutoff in the future → sweep
    expect(await jobs.findByCanvas(canvasId)).toBeNull();
  });

  it("deleteByCanvas removes the job row", async () => {
    await jobs.enqueue(canvasId, V1);
    await jobs.deleteByCanvas(canvasId);
    expect(await jobs.findByCanvas(canvasId)).toBeNull();
  });

  // Review #2 regression: a completion for a row that was coalesced (republished) since
  // it was claimed must be a no-op, so the superseding version stays pending + captured.
  it("markDone is a lease-guarded no-op when the row was re-enqueued since claim", async () => {
    await jobs.enqueue(canvasId, V1);
    const claimed = await jobs.claimNext(Date.now(), Date.now() - 30_000); // running @ V1
    // A republish lands mid-capture: coalesces the same row back to pending @ V2.
    await jobs.enqueue(canvasId, V2);
    // The in-flight V1 capture now completes — but with the OLD lease.
    await jobs.markDone(idOf(claimed), leaseOf(claimed));
    const row = await jobs.findByCanvas(canvasId);
    expect(row?.status).toBe("pending"); // NOT clobbered to done
    expect(row?.versionId).toBe(V2); // V2 survives and will be re-captured
  });

  it("markFailedOrRetry is a lease-guarded no-op when the row was re-enqueued since claim", async () => {
    await jobs.enqueue(canvasId, V1);
    const claimed = await jobs.claimNext(Date.now(), Date.now() - 30_000);
    await jobs.enqueue(canvasId, V2); // coalesce → pending @ V2, lease cleared
    await jobs.markFailedOrRetry(idOf(claimed), "boom", 1, leaseOf(claimed));
    const row = await jobs.findByCanvas(canvasId);
    expect(row?.status).toBe("pending"); // not flipped to failed
    expect(row?.versionId).toBe(V2);
    expect(row?.attempts).toBe(0); // republish reset; not bumped by the stale fail
  });
});
