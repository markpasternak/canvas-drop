import { Buffer } from "node:buffer";
import type { Entry, ZipFile } from "yauzl";
import yauzl from "yauzl";
import { DeployError, LIMITS } from "./errors.js";

/** A single file to deploy: its canvas-relative path and raw bytes. */
export interface DeployEntry {
  path: string;
  bytes: Uint8Array;
}

/** Paste-HTML: a single index.html. */
export function fromPasteHtml(html: string): DeployEntry[] {
  return [{ path: "index.html", bytes: new TextEncoder().encode(html) }];
}

/** yauzl rejects traversal/absolute entry names at the library level — map those
 *  to the stable ZIP_SLIP_REJECTED code; everything else is a malformed archive. */
function zipError(message: string, path?: string): DeployError {
  if (/invalid relative path|absolute path/i.test(message)) {
    return new DeployError("ZIP_SLIP_REJECTED", message, path);
  }
  return new DeployError("INVALID_ZIP", message, path);
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(zipError(err?.message ?? "could not open zip"));
        return;
      }
      resolve(zip);
    });
  });
}

/** Read one entry's bytes, enforcing the per-file cap even if the header lied. */
function readEntryBytes(zip: ZipFile, entry: Entry): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new DeployError("INVALID_ZIP", err?.message ?? "could not read zip entry"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > LIMITS.maxFileBytes) {
          stream.destroy();
          reject(
            new DeployError(
              "ZIP_BOMB_REJECTED",
              `entry exceeds ${LIMITS.maxFileBytes} bytes while inflating`,
              entry.fileName,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      stream.on("error", (e) => reject(new DeployError("INVALID_ZIP", e.message, entry.fileName)));
    });
  });
}

/**
 * Stream a ZIP archive entry-by-entry (KTD-2). Buffers at most one file at a
 * time and checks each entry's declared `uncompressedSize` BEFORE inflating, so
 * a zip-bomb is rejected before it can exhaust memory (a post-inflate cap is too
 * late). `lazyEntries` + pulling the next entry only after the consumer has
 * processed the current one keeps the memory bound to a single file.
 */
export async function* fromZip(buffer: Buffer): AsyncGenerator<DeployEntry> {
  const zip = await openZip(buffer);
  const pending: Entry[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const signal = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  zip.on("entry", (e: Entry) => {
    pending.push(e);
    signal();
  });
  zip.on("end", () => {
    ended = true;
    signal();
  });
  zip.on("error", (e: Error) => {
    failure = e;
    signal();
  });
  zip.readEntry();

  try {
    while (true) {
      if (failure) throw zipError((failure as Error).message);
      if (pending.length === 0) {
        if (ended) break;
        await new Promise<void>((r) => {
          wake = r;
        });
        continue;
      }
      const entry = pending.shift() as Entry;
      if (entry.fileName.endsWith("/")) {
        zip.readEntry(); // directory marker — skip, pull next
        continue;
      }
      // Pre-inflate zip-bomb guard.
      if (entry.uncompressedSize > LIMITS.maxFileBytes) {
        throw new DeployError(
          "ZIP_BOMB_REJECTED",
          `declared size ${entry.uncompressedSize} exceeds the per-file cap`,
          entry.fileName,
        );
      }
      const bytes = await readEntryBytes(zip, entry);
      yield { path: entry.fileName, bytes };
      zip.readEntry(); // backpressure: pull the next only after this one is consumed
    }
  } finally {
    zip.close();
  }
}
