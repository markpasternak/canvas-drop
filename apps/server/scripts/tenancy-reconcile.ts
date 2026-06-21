/**
 * Tenancy membership reconciliation (plan 003 P2 / U2) — dry-run by default, `--apply` to write.
 *
 * After you REMOVE a domain from `CANVAS_DROP_ORG_DOMAINS` and reboot, the boot step prunes
 * `org_domains`, but the materialized `org_members` rows (+ the `team_members` hanging off
 * them) linger. This sweep revokes the stale ones: a `source='domain'` member whose verified
 * email domain no longer maps to that org loses its `org_members` row AND its `team_members`
 * for that org's teams (cascade — else a now-outsider keeps team-canvas access, R13).
 *
 *   pnpm tenancy:reconcile           # DRY RUN — report stale memberships, no writes
 *   pnpm tenancy:reconcile --apply   # revoke stale org_members + cascade team_members
 *
 * The real-time boundary already denies a removed-domain user on their next request (orgIds
 * is resolved live); this only keeps the materialized roster/team tables honest. Idempotent.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@canvas-drop/shared";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { orgsRepository } from "../src/db/repositories/orgs.js";
import { createLogger } from "../src/log/logger.js";
import { materializeOrg } from "../src/tenancy/materialize-org.js";
import { applyReconcile, planReconcile } from "../src/tenancy/reconcile.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const ENV_FILE = join(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const out = (s: string) => process.stdout.write(`${s}\n`);

async function main() {
  const apply = process.argv.includes("--apply");
  const config = loadConfig();
  if (!config.org.name) {
    process.stderr.write(
      "tenancy: no org configured — set CANVAS_DROP_ORG_NAME (+ CANVAS_DROP_ORG_DOMAINS) first.\n",
    );
    process.exit(1);
  }

  const client = makeDb(config);
  await runMigrations(client);
  const orgs = orgsRepository(client);
  // Materialize the configured org (idempotent) so org_domains reflects current config
  // before we decide which memberships are stale.
  await materializeOrg({ config, orgs, log: createLogger(config) });

  const plan = await planReconcile(client, orgs);
  out("");
  out("=== Tenancy reconcile plan (dry-run) ===");
  out(
    `Stale memberships: ${plan.staleMembers.length} (cascade-revokes ${plan.cascadeTeamMembers} team membership(s)).`,
  );
  for (const m of plan.staleMembers) out(`      - ${m.email} (org ${m.orgId})`);
  out("");

  if (!apply) {
    out("DRY RUN — no writes. Re-run with --apply to revoke the stale rows.");
    await client.close();
    return;
  }

  const result = await applyReconcile(client, orgs);
  out(
    `Applied: revoked ${result.revokedMembers} membership(s) + ${result.revokedTeamMembers} team membership(s).`,
  );
  await client.close();
}

main().catch((err) => {
  process.stderr.write(
    `tenancy-reconcile failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
