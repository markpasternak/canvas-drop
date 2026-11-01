#!/usr/bin/env node
// Fresh-image compatibility drill. Requires Docker; uses only uniquely named,
// disposable containers/images/volume and never reads a local .env or live DB.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const suffix = randomUUID().slice(0, 12);
const image = `canvas-drop-smoke:${suffix}`;
const seedImage = `canvas-drop-smoke-seed:${suffix}`;
const volume = `canvas-drop-smoke-${suffix}`;
const server = `canvas-drop-smoke-server-${suffix}`;
const fixture = "/app/scripts/container-smoke-fixture.mjs";
const config = [
  "-e",
  "CANVAS_DROP_AUTH_MODE=proxy",
  "-e",
  "CANVAS_DROP_ALLOWED_EMAIL_DOMAINS=example.com",
  "-e",
  "CANVAS_DROP_TRUSTED_PROXY_IPS=127.0.0.1/32",
  "-e",
  "CANVAS_DROP_SESSION_SECRET=ci-smoke-only-not-a-deployed-secret-00000000",
  "-e",
  "CANVAS_DROP_URL_MODE=subdomain",
  "-e",
  "CANVAS_DROP_BASE_URL=http://canvas.example.com",
  "-e",
  "CANVAS_DROP_SQLITE_PATH=/data/source.db",
  "-e",
  "CANVAS_DROP_STORAGE_PATH=/data/source-storage",
];
const mount = ["--mount", `type=volume,source=${volume},target=/data`];

function docker(args, input) {
  const result = spawnSync("docker", args, {
    cwd: root,
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed (${result.status})`);
}

function fixtureRun(mode, ...args) {
  docker([
    "run",
    "--rm",
    ...mount,
    ...config,
    image,
    "node",
    "--conditions=node-dist",
    fixture,
    mode,
    ...args,
  ]);
}

function ops(command, destination, restored = false) {
  const target = restored
    ? [
        "-e",
        "CANVAS_DROP_SQLITE_PATH=/data/restored.db",
        "-e",
        "CANVAS_DROP_STORAGE_PATH=/data/restored-storage",
      ]
    : [];
  docker([
    "run",
    "--rm",
    ...mount,
    ...config,
    ...target,
    image,
    "node",
    "--conditions=node-dist",
    "apps/server/dist/index.js",
    command,
    destination,
  ]);
}

try {
  console.log("container smoke: build the production image from this checkout");
  docker(["build", "--tag", image, "."]);

  // The old V8-ABI driver must run under Node24, never be loaded into Node26.
  // This independent image seeds the on-disk DB with the previous deployed line.
  console.log("container smoke: seed a populated DB using Node24 and SQLite driver12");
  docker(
    ["build", "--file", "-", "--tag", seedImage, "."],
    `
FROM node:24.22.1-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \\
 && rm -rf /var/lib/apt/lists/*
WORKDIR /legacy
RUN npm install --no-audit --no-fund --save-exact better-sqlite3@12.11.1 drizzle-orm@0.45.4
COPY drizzle /app/drizzle
COPY scripts/container-smoke-fixture.mjs /app/scripts/container-smoke-fixture.mjs
RUN mkdir -p /data && chown 1001:1001 /data
USER 1001:1001
CMD ["node", "/app/scripts/container-smoke-fixture.mjs", "seed"]
`,
  );
  docker(["volume", "create", volume]);
  docker(["run", "--rm", ...mount, seedImage]);
  fixtureRun("database", "/data/source.db", "/data/source-storage");

  console.log("container smoke: boot the normal non-root compiled server");
  docker(["run", "--detach", "--name", server, ...mount, ...config, image]);
  docker(["exec", server, "node", "--conditions=node-dist", fixture, "http"]);
  docker(["stop", "--time", "15", server]);

  console.log("container smoke: exercise compiled backup and restore entrypoints");
  ops("backup", "/data/backup-before");
  ops("restore", "/data/backup-before", true);
  ops("backup", "/data/backup-after", true);
  fixtureRun("database", "/data/restored.db", "/data/restored-storage");
  fixtureRun("backups");
  console.log("container smoke: passed");
} catch (error) {
  spawnSync("docker", ["logs", server], { stdio: "inherit" });
  throw error;
} finally {
  // Cleanup is limited to the random identifiers created by this invocation.
  for (const args of [
    ["rm", "--force", server],
    ["volume", "rm", "--force", volume],
    ["image", "rm", "--force", image, seedImage],
  ]) {
    spawnSync("docker", args, { stdio: "ignore" });
  }
}
