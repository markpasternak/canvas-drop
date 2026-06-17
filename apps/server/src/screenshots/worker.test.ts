import { type Config, loadConfig } from "@canvas-drop/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { CaptureResult } from "./capture.js";
import { type CaptureBrowser, screenshotWorker } from "./worker.js";

const silent = pino({ level: "silent" });
const VERSION = "0190b000-0000-7000-8000-0000000000a1";

const cfg = (extra: Record<string, string> = {}): Config =>
  loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", CANVAS_DROP_SCREENSHOTS: "on", ...extra });

const fakeRenditions = (): CaptureResult => ({
  og: new Uint8Array([1]),
  card: new Uint8Array([2]),
  thumb: new Uint8Array([3]),
});

/** A fake persistent browser that counts launches, contexts, and closes. */
function fakeBrowser() {
  const state = { launches: 0, contexts: 0, closed: 0, contextClosed: 0 };
  const launch = async (): Promise<CaptureBrowser> => {
    state.launches += 1;
    return {
      async newContext() {
        state.contexts += 1;
        return {
          newPage: async () => {
            throw new Error("capture is stubbed in this test");
          },
          async close() {
            state.contextClosed += 1;
          },
        };
      },
      async close() {
        state.closed += 1;
      },
    };
  };
  return { state, launch };
}

describe("screenshotWorker (plan 004 / U5)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function setup(config: Config) {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const jobs = screenshotsRepository(client);
    const user = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const canvas = await canvases.create({ ownerId: user.id, slug: "s", apiKeyHash: "k" });
    const puts: string[] = [];
    const browser = fakeBrowser();
    let enabled = true;
    const worker = screenshotWorker({
      config,
      enabled: async () => enabled,
      jobs,
      canvases,
      storage: { put: async (key) => void puts.push(key) },
      captureUrlFor: () => "http://127.0.0.1:9999/c/s/",
      launchBrowser: browser.launch,
      capture: async () => fakeRenditions(),
      log: silent,
    });
    return {
      jobs,
      canvases,
      canvasId: canvas.id,
      puts,
      browser,
      worker,
      setEnabled: (v: boolean) => {
        enabled = v;
      },
    };
  }

  it("captures a pending job: stores all renditions, marks done, opens+closes a context", async () => {
    const { jobs, canvasId, puts, browser, worker } = await setup(cfg());
    await jobs.enqueue(canvasId, VERSION);
    await worker.tick();

    expect(puts.sort()).toEqual([
      `screenshots/${canvasId}/card.webp`,
      `screenshots/${canvasId}/og.webp`,
      `screenshots/${canvasId}/thumb.webp`,
    ]);
    expect((await jobs.findByCanvas(canvasId))?.status).toBe("done");
    expect(browser.state.launches).toBe(1);
    expect(browser.state.contexts).toBe(1);
    expect(browser.state.contextClosed).toBe(1);
  });

  it("when the admin toggle is OFF: runs bookkeeping but launches no browser and claims nothing", async () => {
    const { jobs, canvasId, browser, worker, setEnabled } = await setup(cfg());
    await jobs.enqueue(canvasId, VERSION);
    setEnabled(false);
    await worker.tick();
    expect(browser.state.launches).toBe(0);
    expect((await jobs.findByCanvas(canvasId))?.status).toBe("pending"); // untouched
  });

  it("a capture failure marks the job failed (at the cap) and recycles the browser", async () => {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const jobs = screenshotsRepository(client);
    const user = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const canvas = await canvases.create({ ownerId: user.id, slug: "s", apiKeyHash: "k" });
    const browser = fakeBrowser();
    const worker = screenshotWorker({
      config: cfg({ CANVAS_DROP_SCREENSHOTS_MAX_ATTEMPTS: "1" }),
      enabled: async () => true,
      jobs,
      canvases,
      storage: { put: async () => {} },
      captureUrlFor: () => "http://127.0.0.1:9999/c/s/",
      launchBrowser: browser.launch,
      capture: async () => {
        throw new Error("render boom");
      },
      log: silent,
    });
    await jobs.enqueue(canvas.id, VERSION);
    await worker.tick();
    expect((await jobs.findByCanvas(canvas.id))?.status).toBe("failed");
    expect(browser.state.closed).toBe(1); // recycled after the failure
  });

  it("recycles the browser after recycleEvery jobs", async () => {
    const { jobs, canvasId, browser, worker } = await setup(
      cfg({ CANVAS_DROP_SCREENSHOTS_RECYCLE_EVERY: "1" }),
    );
    await jobs.enqueue(canvasId, VERSION);
    await worker.tick(); // one job → hits recycleEvery=1 → browser closed
    expect(browser.state.launches).toBe(1);
    expect(browser.state.closed).toBe(1);

    // A second job relaunches a fresh browser.
    await jobs.enqueue(canvasId, "0190b000-0000-7000-8000-0000000000a2");
    await worker.tick();
    expect(browser.state.launches).toBe(2);
  });

  it("recovers after a browser launch failure — it does not poison the worker (review #1)", async () => {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const jobs = screenshotsRepository(client);
    const user = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const canvas = await canvases.create({ ownerId: user.id, slug: "s", apiKeyHash: "k" });
    let launchAttempts = 0;
    const worker = screenshotWorker({
      config: cfg(),
      enabled: async () => true,
      jobs,
      canvases,
      storage: { put: async () => {} },
      captureUrlFor: () => "http://127.0.0.1:9999/c/s/",
      launchBrowser: async () => {
        launchAttempts += 1;
        if (launchAttempts === 1) throw new Error("no chromium"); // first launch fails
        return {
          newContext: async () => ({
            newPage: async () => {
              throw new Error("unused");
            },
            async close() {},
          }),
          async close() {},
        };
      },
      capture: async () => fakeRenditions(),
      log: silent,
    });
    await jobs.enqueue(canvas.id, VERSION);

    await worker.tick(); // launch rejects → job left for retry, worker NOT poisoned
    expect(launchAttempts).toBe(1);
    expect((await jobs.findByCanvas(canvas.id))?.status).not.toBe("done");

    await worker.tick(); // second tick retries the launch (succeeds) and captures
    expect(launchAttempts).toBe(2);
    expect((await jobs.findByCanvas(canvas.id))?.status).toBe("done");
  });

  it("marks a job failed when its canvas isn't capturable (deleted/missing) — no capture", async () => {
    const { jobs, canvases, canvasId, puts, browser, worker } = await setup(
      cfg({ CANVAS_DROP_SCREENSHOTS_MAX_ATTEMPTS: "1" }),
    );
    await jobs.enqueue(canvasId, VERSION);
    await canvases.setStatus(canvasId, "deleted"); // canvas no longer active
    await worker.tick();
    expect((await jobs.findByCanvas(canvasId))?.status).toBe("failed");
    expect(puts).toEqual([]);
    expect(browser.state.launches).toBe(0); // never launched — bailed before capture
  });
});
