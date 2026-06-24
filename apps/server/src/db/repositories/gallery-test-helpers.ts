import type { Manifest } from "@canvas-drop/shared/db";
import type { DbClient } from "../factory.js";
import { type CanvasSettingsPatch, canvasesRepository } from "./canvases.js";
import { usersRepository } from "./users.js";
import { versionsRepository } from "./versions.js";

/**
 * Shared seed helpers for the gallery tests (repo + route). Kept in one place so a
 * new required column on the create/deploy path is a single edit, not two.
 */

const MANIFEST: Manifest = { "index.html": { size: 10, hash: "abc", mime: "text/html" } };

// Monotonic per-process counter for unique slugs / api keys / provider subs.
let seq = 0;

export async function seedUser(client: DbClient, name: string) {
  return usersRepository(client).upsert({
    providerSub: `sub-${seq++}`,
    email: `${name}@example.com`,
    name,
    avatarUrl: `https://avatars.example/${name}.png`,
    isAdmin: false,
  });
}

/** Create a canvas owned by `ownerId` with a ready, current version (so it counts
 *  as "published"). Returns the canvas id. */
export async function seedPublishedCanvas(client: DbClient, ownerId: string): Promise<string> {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const n = seq++;
  const cv = await canvases.create({ ownerId, slug: `slug-${n}`, apiKeyHash: `key-${n}` });
  const v = await versions.createPending({
    canvasId: cv.id,
    number: 1,
    createdBy: ownerId,
    source: "folder",
  });
  await versions.markReady(v.id, { fileCount: 1, totalBytes: 10, manifest: MANIFEST });
  await canvases.setCurrentVersion(cv.id, v.id);
  return cv.id;
}

/** Create an undeployed canvas (no current version) owned by `ownerId`. */
export async function seedUndeployedCanvas(client: DbClient, ownerId: string): Promise<string> {
  const n = seq++;
  const cv = await canvasesRepository(client).create({
    ownerId,
    slug: `slug-${n}`,
    apiKeyHash: `key-${n}`,
  });
  return cv.id;
}

/** Make a published canvas and list it in the gallery with the given settings. */
export async function seedListed(
  client: DbClient,
  ownerId: string,
  patch: CanvasSettingsPatch = {},
): Promise<string> {
  const id = await seedPublishedCanvas(client, ownerId);
  await canvasesRepository(client).updateSettings(id, {
    access: "whole_org",
    discoverability: "listed",
    galleryListed: true,
    description: "A useful canvas",
    tags: ["charts"],
    ...patch,
  });
  return id;
}
