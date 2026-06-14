#!/usr/bin/env node
// Stop the dev pair started by `pnpm dev`, cleanly — no orphaned vite/tsx procs.
// Reads the launcher pid recorded in the worktree-root `.dev.pid` and sends
// SIGTERM; scripts/dev.mjs forwards it to its pnpm child, which stops vite + tsx
// and removes the pid file. Idempotent: a missing or stale pid is a no-op, so this
// is safe to run before `pnpm dev` (i.e. `pnpm dev:restart`) or on its own.
import { readFileSync, unlinkSync } from "node:fs";

const PID_FILE = new URL("../.dev.pid", import.meta.url);

let pid;
try {
  pid = Number(readFileSync(PID_FILE, "utf8").trim());
} catch {
  console.log("dev:stop — no .dev.pid; nothing running from this worktree.");
  process.exit(0);
}

if (!Number.isInteger(pid) || pid <= 0) {
  console.log("dev:stop — .dev.pid is malformed; clearing it.");
  try {
    unlinkSync(PID_FILE);
  } catch {}
  process.exit(0);
}

try {
  process.kill(pid, "SIGTERM");
  console.log(`dev:stop — sent SIGTERM to dev launcher pid ${pid}.`);
} catch (err) {
  if (err.code === "ESRCH") {
    console.log(`dev:stop — pid ${pid} already gone; clearing stale .dev.pid.`);
  } else {
    throw err;
  }
}
// dev.mjs unlinks the pid file on its own exit; clear it here too in case the
// launcher was already gone (stale pid) so a later dev:stop doesn't re-warn.
try {
  unlinkSync(PID_FILE);
} catch {}
