/**
 * Tenancy cutover (plan 002 U8) — dry-run by default, `--apply` to write.
 *
 * Auto-scopes existing data once an org is configured. The DEFAULT is a read-only
 * dry-run: it materializes the configured org, classifies every user (member/guest),
 * and reports each canvas's computed home org + access delta, with NO writes. Review
 * that report — especially the access changes + reclassified admins — against a RESTORED
 * COPY of production before applying.
 *
 *   pnpm tenancy:plan            # DRY RUN — classify + report, no writes
 *   pnpm tenancy:plan --apply    # idempotent backfill + clamp, then verify
 *
 * Apply is idempotent (org_id set WHERE org_id IS NULL; guest-owned whole_org → private)
 * and resume-safe. Always run the dry-run before every apply, including config-changed
 * re-applies. See docs/tenancy.md.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@canvas-drop/shared";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { orgsRepository } from "../src/db/repositories/orgs.js";
import { createLogger } from "../src/log/logger.js";
import {
  applyTenancy,
  planTenancy,
  type TenancyPlan,
  verifyTenancy,
} from "../src/tenancy/cutover.js";
import { materializeOrg } from "../src/tenancy/materialize-org.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const ENV_FILE = join(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const out = (s: string) => process.stdout.write(`${s}\n`);

function report(plan: TenancyPlan) {
  out("");
  out("=== Tenancy cutover plan (dry-run) ===");
  out(
    `Users: ${plan.users.total} total — ${plan.users.members} member(s), ${plan.users.guests} guest(s).`,
  );
  if (plan.users.reclassifiedAdmins.length > 0) {
    out(`  ⚠ ${plan.users.reclassifiedAdmins.length} ADMIN(s) on a non-org domain become GUESTS:`);
    for (const a of plan.users.reclassifiedAdmins) out(`      - ${a.email}`);
  }
  out(
    `Canvases: ${plan.canvases.total} total — ${plan.canvases.willAssignOrg} will get an org, ` +
      `${plan.canvases.willClampToPrivate} guest-owned whole_org will be CLAMPED to private, ` +
      `${plan.canvases.alreadyScoped} already homed.`,
  );
  const changes = plan.details.filter(
    (d) => d.assignOrgId !== null || d.accessBefore !== d.accessAfter,
  );
  if (changes.length > 0) {
    out("  Per-canvas changes:");
    for (const d of changes) {
      const access =
        d.accessBefore === d.accessAfter ? d.accessBefore : `${d.accessBefore} → ${d.accessAfter}`;
      out(
        `      - ${d.slug} (owner @${d.ownerDomain ?? "—"}): org=${d.assignOrgId ?? "personal"}, access ${access}`,
      );
    }
  }
  out("");
}

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
  // Materialize the configured org (idempotent) so the classifier has its domains.
  await materializeOrg({ config, orgs, log: createLogger(config) });

  const plan = await planTenancy(client, orgs);
  report(plan);

  if (!apply) {
    out("DRY RUN — no writes. Re-run with --apply to apply the backfill + clamp.");
    await client.close();
    return;
  }

  const result = await applyTenancy(client, orgs);
  out(`Applied: ${result.assigned} canvas(es) homed, ${result.clamped} clamped to private.`);
  const { ok, plan: after } = await verifyTenancy(client, orgs);
  if (!ok) {
    process.stderr.write(
      `tenancy: post-apply verify FAILED — ${after.canvases.willAssignOrg} unhomed, ` +
        `${after.canvases.willClampToPrivate} unclamped remain. Investigate before serving.\n`,
    );
    await client.close();
    process.exit(1);
  }
  out("Post-apply verify: OK — zero remaining changes. The cutover is complete.");
  await client.close();
}

main().catch((err) => {
  process.stderr.write(`tenancy-plan failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
