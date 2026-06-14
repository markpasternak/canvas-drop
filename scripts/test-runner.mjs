#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DASHBOARD_ROOT = join(REPO_ROOT, "apps/dashboard");
const NESTED_AGENT_ROOTS = [
  join(REPO_ROOT, ".agents/worktrees"),
  join(REPO_ROOT, ".claude/worktrees"),
  join(REPO_ROOT, ".codex/worktrees"),
];
const REGISTRY_DIR =
  process.env.CANVAS_DROP_TEST_REGISTRY_DIR ??
  (process.platform === "win32"
    ? join(process.env.TEMP ?? REPO_ROOT, "canvas-drop-test-runs")
    : "/tmp/canvas-drop-test-runs");

const RUN_ID = sanitizeRunId(
  process.env.CANVAS_DROP_TEST_RUN_ID ?? `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`,
);
const REGISTRY_FILE = join(REGISTRY_DIR, `${RUN_ID}.json`);

// A unique marker injected into every child's environment so the orphan reaper can
// verify a still-alive pid is genuinely OUR child before signalling it. A bare
// command substring ('node ', 'vitest', 'pnpm') is not enough: after the OS recycles
// a dead child's pid onto an unrelated Node process, that process would match the
// substring and we could SIGKILL its whole group. The marker survives pid reuse —
// the recycled process won't carry it — so identity is precise, not heuristic.
const CHILD_MARKER_VAR = "CANVAS_DROP_TEST_CHILD_MARKER";
const CHILD_MARKER = `${RUN_ID}-${randomUUID()}`;
const VALUE_FLAGS = new Set([
  "-t",
  "--config",
  "--dir",
  "--environment",
  "--hookTimeout",
  "--maxWorkers",
  "--minWorkers",
  "--pool",
  "--reporter",
  "--root",
  "--testNamePattern",
  "--testTimeout",
]);

let currentChild = null;
let cleaned = false;

export function sanitizeRunId(value) {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 120);
  return cleaned || `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export function computeWorkerBudget({ cores, activeRuns, override } = {}) {
  if (override?.trim()) return override.trim();
  const safeCores = Number.isInteger(cores) && cores > 0 ? cores : 1;
  const safeRuns = Number.isInteger(activeRuns) && activeRuns > 0 ? activeRuns : 1;
  const sharedPool = Math.max(1, Math.floor(safeCores / 2));
  return String(Math.max(1, Math.floor(sharedPool / safeRuns)));
}

export function vitestWorkerValue(raw, fallback = "50%") {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (/^[1-9]\d*%$/.test(trimmed)) return trimmed;
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1) return n;
  return fallback;
}

export function normalizeVitestArgs(args) {
  return args[0] === "--" ? args.slice(1) : args;
}

function modeFromArgs(args) {
  const [mode = "full", ...rest] = args;
  if (["full", "root", "dashboard", "file"].includes(mode)) return { mode, rest };
  return { mode: "full", rest: args };
}

function cpuCount() {
  return typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
}

function ensureRegistry() {
  mkdirSync(REGISTRY_DIR, { recursive: true });
}

function registryEntries() {
  if (!existsSync(REGISTRY_DIR)) return [];
  return readdirSync(REGISTRY_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        return {
          file: join(REGISTRY_DIR, file),
          data: JSON.parse(readFileSync(join(REGISTRY_DIR, file), "utf8")),
        };
      } catch {
        return { file: join(REGISTRY_DIR, file), data: null };
      }
    });
}

function writeRegistry(patch = {}) {
  const existing = existsSync(REGISTRY_FILE) ? JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) : {};
  writeFileSync(
    REGISTRY_FILE,
    JSON.stringify(
      {
        ...existing,
        runId: RUN_ID,
        repoRoot: REPO_ROOT,
        launcherPid: process.pid,
        startedAt: existing.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...patch,
      },
      null,
      2,
    ),
  );
}

function removeRegistry(file = REGISTRY_FILE) {
  try {
    rmSync(file, { force: true });
  } catch {}
}

function cacheDirsForRun(runId = RUN_ID) {
  const safeRunId = sanitizeRunId(runId);
  return [
    join(REPO_ROOT, "node_modules/.vite", `vitest-${safeRunId}-root`),
    join(DASHBOARD_ROOT, "node_modules/.vite", `vitest-${safeRunId}-dashboard`),
  ];
}

function removeRunArtifacts(runId = RUN_ID) {
  for (const cacheDir of cacheDirsForRun(runId)) {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function activeRunIds() {
  return new Set(
    registryEntries()
      .filter(({ data }) => data?.runId && data?.launcherPid && pidAlive(data.launcherPid))
      .map(({ data }) => sanitizeRunId(data.runId)),
  );
}

function removeStaleRunArtifacts() {
  const active = activeRunIds();
  for (const { root, suffix } of [
    { root: join(REPO_ROOT, "node_modules/.vite"), suffix: "-root" },
    { root: join(DASHBOARD_ROOT, "node_modules/.vite"), suffix: "-dashboard" },
  ]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("vitest-") || !entry.name.endsWith(suffix)) continue;
      const runId = entry.name.slice("vitest-".length, -suffix.length);
      if (!active.has(runId)) rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function pidCommand(pid) {
  if (process.platform === "win32") return "";
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * The full environment of a pid, as `KEY=value KEY2=value2 ...` (best-effort).
 * `ps eww` prints the process environment after the command on macOS/Linux; we use
 * it to confirm a live pid still carries our injected child marker before signalling
 * it, which is robust to OS pid reuse (a recycled pid won't carry the marker).
 */
function pidEnviron(pid) {
  if (process.platform === "win32") return "";
  try {
    return execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * True only when the live `entry.childPid` is verifiably OUR registered child.
 * Preferred signal: the unique child marker we injected into its env still appears
 * in the process environment. When the marker is unavailable (older registry entry,
 * or `ps eww` blocked/unsupported), fall back to the original command-substring
 * heuristic so behaviour never regresses — but the marker path is what prevents a
 * recycled-pid false positive.
 */
function looksLikeRegisteredChild(entry) {
  const childPid = entry.childPid ?? 0;
  if (entry.childMarker) {
    return pidEnviron(childPid).includes(`${CHILD_MARKER_VAR}=${entry.childMarker}`);
  }
  const cmd = pidCommand(childPid);
  if (!cmd) return false;
  return (
    cmd.includes("pnpm") || cmd.includes("vitest") || cmd.includes("node ") || cmd.endsWith("node")
  );
}

function signalChildGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (err) {
    if (err?.code !== "ESRCH") throw err;
  }
}

function childGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") return pidAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function reapRegisteredOrphan(entry) {
  const childPid = entry.childPid;
  if (!Number.isInteger(childPid) || !childGroupAlive(childPid)) return;
  if (pidAlive(childPid) && !looksLikeRegisteredChild(entry)) return;

  signalChildGroup(childPid, "SIGTERM");
  await sleep(750);
  if (childGroupAlive(childPid)) {
    signalChildGroup(childPid, "SIGKILL");
  }
}

async function pruneRegistry() {
  ensureRegistry();
  for (const { file, data } of registryEntries()) {
    if (!data || !Number.isInteger(data.launcherPid)) {
      removeRegistry(file);
      continue;
    }
    if (pidAlive(data.launcherPid)) continue;
    await reapRegisteredOrphan(data);
    removeRunArtifacts(data.runId);
    removeRegistry(file);
  }
}

function activeRunCount() {
  return registryEntries().filter(({ data }) => data?.launcherPid && pidAlive(data.launcherPid))
    .length;
}

function displayCommand(command, args) {
  return [command, ...args].join(" ");
}

function packageCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function processList() {
  if (process.platform === "win32") return [];
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function looksLikeTestProcess(command) {
  return (
    command.includes("vitest") ||
    command.includes("scripts/test-runner.mjs") ||
    command.includes("scripts/test-runner.test.mjs")
  );
}

function pathIsInThisWorktree(text) {
  const index = text.indexOf(REPO_ROOT);
  if (index === -1) return false;
  const path = text.slice(index);
  return !NESTED_AGENT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function textTouchesThisWorktree(text) {
  return text.split(/\s+/).some(pathIsInThisWorktree);
}

function processTouchesWorktree(pid, command) {
  if (textTouchesThisWorktree(command)) return true;
  if (process.platform === "win32") return false;
  try {
    const lsof = execFileSync("lsof", ["-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    return textTouchesThisWorktree(lsof);
  } catch {
    return false;
  }
}

function localInFlightTests() {
  return processList().filter(
    (row) =>
      row.pid !== process.pid &&
      row.pid !== process.ppid &&
      looksLikeTestProcess(row.command) &&
      processTouchesWorktree(row.pid, row.command),
  );
}

// Bound the wait so a hung/deadlocked test process in this worktree can't block a
// run forever (e.g. a stuck pglite worker would otherwise pin a CI job until the
// job-level timeout with no actionable signal). After the ceiling we abort with a
// diagnostic and a non-zero exit rather than looping indefinitely.
const MAX_LOCAL_SLOT_WAIT_SEC = 10 * 60;

async function waitForLocalTestSlot() {
  let waited = 0;
  while (true) {
    const inFlight = localInFlightTests();
    if (inFlight.length === 0) return;
    const sample = inFlight
      .slice(0, 3)
      .map((row) => `${row.pid} ${row.command.slice(0, 90)}`)
      .join("; ");
    if (waited >= MAX_LOCAL_SLOT_WAIT_SEC) {
      console.error(
        `test-runner: timed out after ${waited}s waiting for a local test slot in this worktree; ` +
          `the blocking process(es) appear stuck (${sample}). Aborting — kill them and retry.`,
      );
      process.exit(1);
    }
    console.log(`test-runner: waiting for existing test process(es) in this worktree (${sample})`);
    await sleep(5_000);
    waited += 5;
    if (waited % 30 === 0) {
      console.log(`test-runner: still waiting for local test slot after ${waited}s`);
    }
  }
}

function isOptionValue(args, index) {
  return VALUE_FLAGS.has(args[index - 1]);
}

function positionalArgs(args) {
  return args.filter((arg, index) => !arg.startsWith("-") && !isOptionValue(args, index));
}

function hasReporter(args) {
  return args.some(
    (arg, index) =>
      arg === "--reporter" || arg.startsWith("--reporter=") || args[index - 1] === "--reporter",
  );
}

export function withFileReporter(args) {
  return hasReporter(args) ? args : [...args, "--reporter=verbose"];
}

export function targetArgsForDashboard(args) {
  return args.map((arg, index) => {
    if (arg.startsWith("-") || isOptionValue(args, index)) return arg;
    const abs = resolve(REPO_ROOT, arg);
    if (!abs.startsWith(`${DASHBOARD_ROOT}/`)) return arg;
    return relative(DASHBOARD_ROOT, abs);
  });
}

function phasesFor(mode, args) {
  const rootPhase = {
    name: "root",
    cwd: REPO_ROOT,
    env: {},
    args,
  };
  const dashboardPhase = {
    name: "dashboard",
    cwd: DASHBOARD_ROOT,
    env: {},
    args: targetArgsForDashboard(args),
  };

  if (mode === "root") return [rootPhase];
  if (mode === "dashboard") return [dashboardPhase];
  if (mode === "file") {
    const hasDashboardFile = args.some(
      (arg, index) =>
        !arg.startsWith("-") &&
        !isOptionValue(args, index) &&
        resolve(REPO_ROOT, arg).startsWith(`${DASHBOARD_ROOT}/`),
    );
    const phase = hasDashboardFile ? dashboardPhase : rootPhase;
    const targetArgs = hasDashboardFile ? dashboardPhase.args : args;
    const targets = positionalArgs(targetArgs).join(", ");
    return [
      {
        ...phase,
        args: withFileReporter([
          "--pool=forks",
          "--poolOptions.forks.singleFork",
          "--no-file-parallelism",
          ...targetArgs,
        ]),
        progressLabel: targets || "filtered single-file run",
      },
    ];
  }
  return [rootPhase, dashboardPhase];
}

async function runPhase(phase, sharedEnv) {
  await waitForLocalTestSlot();
  const command = packageCommand();
  const args = ["exec", "vitest", "run", ...phase.args];
  const env = {
    ...process.env,
    ...sharedEnv,
    ...phase.env,
    [CHILD_MARKER_VAR]: CHILD_MARKER,
  };

  console.log(`test-runner: ${phase.name} -> ${displayCommand(command, args)}`);
  const child = spawn(command, args, {
    cwd: phase.cwd,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  currentChild = child;
  const startedAt = Date.now();
  const progressTimer = phase.progressLabel
    ? setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(
          `test-runner: ${phase.name} still running after ${elapsed}s (${phase.progressLabel}); child pid ${child.pid}`,
        );
      }, 15_000)
    : null;
  progressTimer?.unref?.();

  writeRegistry({
    phase: phase.name,
    childPid: child.pid,
    childCommand: displayCommand(command, args),
    childMarker: CHILD_MARKER,
  });

  const result = await new Promise((resolveRun, rejectRun) => {
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => resolveRun({ code, signal }));
  });

  if (progressTimer) clearInterval(progressTimer);
  const childPid = currentChild?.pid;
  if (childPid && childGroupAlive(childPid)) {
    console.warn(
      `test-runner: child exited but owned process group ${childPid} still has members; terminating it`,
    );
    signalChildGroup(childPid, "SIGTERM");
    await sleep(750);
    if (childGroupAlive(childPid)) signalChildGroup(childPid, "SIGKILL");
  }
  currentChild = null;
  writeRegistry({ phase: null, childPid: null, childCommand: null });

  if (result.signal) return { ok: false, code: 1, signal: result.signal };
  if (result.code !== 0) return { ok: false, code: result.code ?? 1 };
  return { ok: true, code: 0 };
}

async function cleanupAndExit(code) {
  if (cleaned) {
    // A second signal arrived while the first (async) cleanup is still in flight
    // — e.g. a double Ctrl-C. Don't wait on the in-progress SIGTERM→sleep→SIGKILL
    // path: kill the child group synchronously now so the children can't outlive
    // us, then bail. The first invocation still calls process.exit once it settles.
    if (currentChild?.pid) signalChildGroup(currentChild.pid, "SIGKILL");
    return;
  }
  cleaned = true;
  if (currentChild?.pid) {
    signalChildGroup(currentChild.pid, "SIGTERM");
    await sleep(750);
    if (childGroupAlive(currentChild.pid)) signalChildGroup(currentChild.pid, "SIGKILL");
  }
  removeRunArtifacts();
  removeRegistry();
  process.exit(code);
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      void cleanupAndExit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

async function main() {
  const parsed = modeFromArgs(process.argv.slice(2));
  const mode = parsed.mode;
  const rest = normalizeVitestArgs(parsed.rest);
  const dialect = mode === "root" && rest[0] === "--dialect" ? rest.splice(0, 2)[1] : undefined;

  await pruneRegistry();
  removeStaleRunArtifacts();
  writeRegistry({ mode, childPid: null, childCommand: null });
  installSignalHandlers();

  const budget = computeWorkerBudget({
    cores: cpuCount(),
    activeRuns: activeRunCount(),
    override: process.env.CANVAS_DROP_TEST_MAX_WORKERS,
  });
  writeRegistry({ workerBudget: budget });

  const sharedEnv = {
    CANVAS_DROP_TEST_RUN_ID: RUN_ID,
    CANVAS_DROP_TEST_MAX_WORKERS: budget,
    ...(dialect ? { CANVAS_DROP_DB: dialect } : {}),
  };

  console.log(
    `test-runner: run ${RUN_ID} using maxWorkers=${budget} (${activeRunCount()} active registered run(s))`,
  );

  for (const phase of phasesFor(mode, rest)) {
    const result = await runPhase(phase, sharedEnv);
    if (!result.ok) {
      removeRunArtifacts();
      removeRegistry();
      process.exit(result.code ?? 1);
    }
  }

  removeRunArtifacts();
  removeRegistry();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    removeRunArtifacts();
    removeRegistry();
    console.error(err);
    process.exit(1);
  });
}
