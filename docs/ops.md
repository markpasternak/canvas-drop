# Operations runbook

How to keep a self-hosted canvas-drop instance healthy: **backups**, **restore drills**,
and the **scheduled maintenance** (prune/GC) that bounds its growth. Everything here uses
the server binary's own subcommands — no `pg_dump`, `aws`, or extra tooling — so the same
production image runs the cron jobs.

> The maintenance commands read the same typed config (`CANVAS_DROP_*`) as the server, so
> they act on whichever DB (SQLite/Postgres) and storage (local/S3) the instance is wired
> to. Run them as the app, in the app's container.

---

## 1. Backup

A backup is a **self-describing directory**:

```
<dir>/meta.json          format version, source dialect, row/blob counts, timestamp
<dir>/db/<table>.ndjson  every row of every table, one JSON object per line
<dir>/blobs/<key>        every content-addressed storage object, verbatim
```

It captures the **whole instance**: the database (all 20 tables) and the content-addressed
storage (every canvas's deployed files). Take one with:

```bash
# Dev (from the repo root):
pnpm backup ./backups/$(date -u +%Y%m%dT%H%M%SZ)

# Production (inside the app container — same binary as the server):
node --conditions=node-dist apps/server/dist/index.js backup /backups/$(date -u +%Y%m%dT%H%M%SZ)
```

Compression and off-site copy are yours to own (a backup is a plain directory):

```bash
DEST=/backups/$(date -u +%Y%m%dT%H%M%SZ)
node --conditions=node-dist apps/server/dist/index.js backup "$DEST"
tar -czf "$DEST.tar.gz" -C "$(dirname "$DEST")" "$(basename "$DEST")" && rm -rf "$DEST"
# …then ship "$DEST.tar.gz" to object storage / another host.
```

**Driver-agnostic on both axes.** Because the dump goes through the DB and storage
*interfaces*, a backup taken on `sqlite + local` restores cleanly into `postgres + s3`
and vice-versa. So backup→restore is also the supported way to **migrate** between drivers
(e.g. graduate a trial from SQLite to Postgres, or local disk to S3) — point the target
instance's config at the new drivers and restore.

---

## 2. Restore (and the drill)

Restore into a **fresh, empty** instance (the command refuses a non-empty database unless
you pass `--force`). It runs migrations first, so the target DB can be brand new:

```bash
node --conditions=node-dist apps/server/dist/index.js restore /backups/20260620T031500Z
```

**Run the drill quarterly** (and after any major upgrade) so the backups are known-good:

1. Take a fresh backup (above).
2. Bring up a **throwaway** instance pointed at an empty DB + empty storage
   (e.g. `CANVAS_DROP_DB_PATH=/tmp/drill.db`, `CANVAS_DROP_STORAGE_PATH=/tmp/drill-store`).
3. `… restore <backup-dir>` into it.
4. Sign in and spot-check: a known canvas loads, its files serve, settings/users are intact.
5. Tear the throwaway down.

A green restore is the only proof a backup is real. The automated round-trip
(`apps/server/src/ops/backup.test.ts`) runs this on **both** dialects in CI, but it does
not exercise *your* data or *your* storage backend — the periodic manual drill does.

---

## 3. Scheduled maintenance (prune / GC)

canvas-drop appends as it runs (metering rows on every primitive op; soft-deleted canvases
keep their files as tombstones until reclaimed). One sweep bounds all of it:

```bash
# Reclaim soft-deleted canvases' files + version rows, and prune the metering tables.
node --conditions=node-dist apps/server/dist/index.js purge            # everything eligible
node --conditions=node-dist apps/server/dist/index.js purge 30         # only deleted 30+ days ago
node --conditions=node-dist apps/server/dist/index.js purge 30 dry-run # report only, delete nothing
```

What `purge` does: hard-deletes each soft-deleted canvas's storage objects + version rows
(keeping the row as a tombstone), and prunes `usage_events` / `ai_usage` older than 90 days.
Per-canvas blob GC (orphaned draft-churn blobs) runs inline after each publish/deploy, so
`purge` is the periodic backstop, not the only reclaimer.

---

## 4. Recommended cron schedule

A sensible default for a single-VPS install. **Nightly backup, weekly purge**, with local
backup retention so the disk doesn't fill. Times are UTC; stagger them off the hour.

### Option A — host crontab (simplest)

Run on the Docker host (`crontab -e`). Adjust the compose project dir + service name.

```cron
# canvas-drop maintenance — UTC. App service is `app` in /opt/canvas-drop/docker-compose.yml.
CD=/usr/bin/docker compose -f /opt/canvas-drop/docker-compose.yml
BIN=node --conditions=node-dist apps/server/dist/index.js

# 03:15 nightly — full backup into the backups volume, then tar + 14-day retention.
15 3 * * *  $CD exec -T app sh -lc 'D=/backups/$(date -u +\%Y\%m\%dT\%H\%M\%SZ); '"$BIN"' backup "$D" && tar -czf "$D.tar.gz" -C /backups "$(basename "$D")" && rm -rf "$D" && find /backups -name "*.tar.gz" -mtime +14 -delete'

# 03:45 Sunday — reclaim canvases soft-deleted 30+ days ago + prune metering tables.
45 3 * * 0  $CD exec -T app sh -lc ''"$BIN"' purge 30'
```

> `%` must be escaped as `\%` in crontab. `exec -T` disables the TTY so cron can run it
> non-interactively. The backups land on a dedicated `/backups` volume (see below) —
> **never** the same volume as the data it protects.

### Option B — compose maintenance sidecar (self-contained)

`docker-compose.yml` ships a commented‑out `maintenance` service (a tiny `supercronic`
sidecar sharing the app image + volumes) and a `backups` volume. Uncomment them and drop a
crontab at `docker/maintenance.cron` to keep the schedule inside compose — no host crontab,
moves with the stack. The same two jobs as Option A.

### Retention & off-site

- Keep ~14 local daily backups (the `find … -mtime +14 -delete` above); copy at least the
  latest off-host (object storage with versioning, or `rsync` to another machine). A backup
  that lives only on the same host is not a backup.
- If storage is **S3**, the blobs already have a durable home — enable bucket **versioning**
  for point-in-time object recovery and the nightly backup is mainly your **database**
  insurance. With **local** storage, the nightly backup is your only copy: get it off-host.

---

## 5. At a glance

| Job | Command | Suggested cadence |
|---|---|---|
| Backup | `… index.js backup <dir>` | nightly |
| Restore | `… index.js restore <dir>` | on recovery + quarterly drill |
| Purge / prune | `… index.js purge [days]` | weekly |

All three are also available in dev as `pnpm backup`, `pnpm restore`, `pnpm purge`.
