#!/usr/bin/env node
// Dev launcher: load the worktree-root `.env` into the environment, then run the
// parallel dev servers so both children (apps/server via tsx, apps/dashboard via
// vite) inherit it.
//
// Why this exists: nothing else in the repo reads the `.env` *file*. The app is
// 12-factor — `loadConfig` only reads `process.env`, and production injects config
// via systemd's `EnvironmentFile=/etc/canvas-drop.env` (see deploy/), never by the
// app loading a file. That left the documented quickstart (`cp .env.example .env &&
// pnpm dev`) silently ignoring `.env`: it only appeared to work because the boot
// defaults happen to match the dev profile, so any real customization (ports,
// session secret, admin emails, oidc) was dropped on the floor.
//
// This launcher is invoked as `node --env-file-if-exists=.env scripts/dev.mjs`
// (see the root `dev` script), so:
//   - the root `.env` is loaded ONCE here and inherited by every child;
//   - `--env-file-if-exists` is a no-op when `.env` is absent (a bare clone still
//     boots on defaults);
//   - already-set environment variables WIN over the file, so an explicit export
//     (e.g. a parallel agent's `CANVAS_DROP_PORT=3003 pnpm dev`) and production's
//     systemd env both still override. Dev-only; production never runs this.
import { spawn } from "node:child_process";

const child = spawn("pnpm", ["-r", "--parallel", "dev"], { stdio: "inherit" });

const forward = (signal) => child.kill(signal);
process.on("SIGINT", forward);
process.on("SIGTERM", forward);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(`dev launcher failed to start pnpm: ${err.message}`);
  process.exit(1);
});
