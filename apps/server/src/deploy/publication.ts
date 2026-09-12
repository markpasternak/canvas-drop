import type { Canvas, Version } from "@canvas-drop/shared/db";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { type CurrentPublication, DeployError } from "./errors.js";

/**
 * Deployment coordination (plan 2026-09-12): the optional fields a publisher may attach
 * to a deploy, and the one classifier every entry path uses to decide between
 * `already_current`, `RELEASE_NOT_CURRENT` and a normal publication (KTD4).
 */

/** The two optional coordination fields, as a caller supplies them (unvalidated). */
export interface CoordinationInput {
  releaseId?: string | null;
  expectedPublicationToken?: string | null;
}

/** The same fields after validation: a field is present only when supplied. */
export interface Coordination {
  releaseId?: string;
  expectedPublicationToken?: string;
}

export const RELEASE_ID_MAX_LENGTH = 200;
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * R1: a release identity is 1–200 characters of text with no control characters. It is
 * opaque — stored verbatim, never parsed. `undefined`/`null` mean "not supplied".
 */
export function validateReleaseId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new DeployError("INVALID_RELEASE_ID", "releaseId must be a string");
  }
  if (raw.length === 0 || raw.length > RELEASE_ID_MAX_LENGTH) {
    throw new DeployError(
      "INVALID_RELEASE_ID",
      `releaseId must be 1–${RELEASE_ID_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new DeployError("INVALID_RELEASE_ID", "releaseId must not contain control characters");
  }
  return raw;
}

/** Validate the release identity and carry any supplied token verbatim (a bad token is a mismatch, not an input error). */
export function normalizeCoordination(input: CoordinationInput | undefined): Coordination {
  const out: Coordination = {};
  const releaseId = validateReleaseId(input?.releaseId);
  if (releaseId !== undefined) out.releaseId = releaseId;
  if (typeof input?.expectedPublicationToken === "string") {
    out.expectedPublicationToken = input.expectedPublicationToken;
  }
  return out;
}

export interface PublicationDeps {
  canvases: Pick<CanvasesRepository, "findById">;
  versions: Pick<VersionsRepository, "findById" | "findReadyByRelease">;
}

/** The current publication of a canvas: token plus the live version's identity (R2 / R6). */
export function publicationOf(canvas: Canvas, current: Version | null): CurrentPublication {
  return {
    publicationToken: canvas.publicationToken,
    versionId: current?.id ?? null,
    version: current?.number ?? null,
    releaseId: current?.releaseId ?? null,
  };
}

async function loadCanvasAndCurrent(
  deps: PublicationDeps,
  canvasId: string,
): Promise<{ canvas: Canvas; current: Version | null }> {
  const canvas = await deps.canvases.findById(canvasId);
  if (!canvas) throw new Error("Canvas is unavailable for publication");
  const current = canvas.currentVersionId
    ? await deps.versions.findById(canvas.currentVersionId)
    : null;
  return { canvas, current };
}

export async function currentPublication(
  deps: PublicationDeps,
  canvasId: string,
): Promise<CurrentPublication> {
  const { canvas, current } = await loadCanvasAndCurrent(deps, canvasId);
  return publicationOf(canvas, current);
}

export type Classification =
  /** The release is on the current, ready version — the caller's work is already live (R3). */
  | { kind: "already_current"; canvas: Canvas; current: Version }
  /** The release is on another kept ready version — the holder — but not live (R4). */
  | { kind: "release_not_current"; canvas: Canvas; current: Version | null; holder: Version }
  /** No kept ready version carries the release. */
  | { kind: "absent"; canvas: Canvas; current: Version | null };

/** One read of the canvas, its current version and the release's ready holder (KTD4). */
export async function classifyPublication(
  deps: PublicationDeps,
  canvasId: string,
  releaseId: string,
): Promise<Classification> {
  const { canvas, current } = await loadCanvasAndCurrent(deps, canvasId);
  const holder = await deps.versions.findReadyByRelease(canvasId, releaseId);
  if (!holder) return { kind: "absent", canvas, current };
  if (current && holder.id === current.id) return { kind: "already_current", canvas, current };
  return { kind: "release_not_current", canvas, current, holder };
}

/**
 * How recently a ready-but-not-current holder must have been created to count as a
 * winner still between its `markReady` and its swap (KTD4). Any real deploy commits
 * within seconds; a holder older than this is history (a rollback moved off it, or its
 * publisher crashed) and is reported at once instead of waited on.
 */
export const IN_FLIGHT_WINDOW_MS = 60 * 1000;

/** A holder that is ready, not current, and created within the in-flight window. */
export function holderInFlight(
  c: Classification,
  now: number = Date.now(),
  windowMs: number = IN_FLIGHT_WINDOW_MS,
): boolean {
  return c.kind === "release_not_current" && c.holder.createdAt > now - windowMs;
}

export interface WaitOptions {
  /** Polls before giving up (default 20). */
  attempts?: number;
  /** Delay between polls in ms (default 100). */
  intervalMs?: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock. */
  now?: () => number;
  /** Override of {@link IN_FLIGHT_WINDOW_MS}. */
  inFlightWindowMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The bounded wait of KTD4. Re-classifies until the holder either lands
 * (`already_current`), disappears (`absent` — the winner withdrew after its own activation
 * failed), or proves historical (`release_not_current` with a holder older than the live
 * version, returned at once). A holder that stays in flight past `attempts` polls is
 * returned as `release_not_current` with `timedOut: true` — a crashed winner leaves such a
 * ready row, which the caller can roll back to.
 */
export async function awaitHolder(
  deps: PublicationDeps,
  canvasId: string,
  releaseId: string,
  opts: WaitOptions = {},
): Promise<{ classification: Classification; timedOut: boolean }> {
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 100;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const windowMs = opts.inFlightWindowMs ?? IN_FLIGHT_WINDOW_MS;
  let classification = await classifyPublication(deps, canvasId, releaseId);
  for (let i = 0; i < attempts; i++) {
    if (!holderInFlight(classification, now(), windowMs)) {
      return { classification, timedOut: false };
    }
    await sleep(intervalMs);
    classification = await classifyPublication(deps, canvasId, releaseId);
  }
  return { classification, timedOut: holderInFlight(classification, now(), windowMs) };
}
