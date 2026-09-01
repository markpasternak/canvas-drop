/**
 * Dev seed: collaborators on the showcase demo apps, so the marketing / docs screenshots
 * tell the editor-roles story (plan 2026-09-01) with real rows instead of an empty
 * People list.
 *
 * Run from the repo root AFTER `pnpm seed:canvases && pnpm seed:demo-apps`, against the
 * SQLite dev DB:
 *   pnpm seed:collaborators
 *
 * What it seeds (neutral @example.com people only, R11; idempotent):
 *   - "Pricing Calculator" (the tour canvas): a direct editor, a viewer, a personal "Design"
 *     team granted as editors, and a pending editor invite that has not signed in yet.
 *   - "Sprint Board": ownership moved to a colleague with the dev admin kept as an editor,
 *     so the admin's own dashboard shows an edited canvas ("editor · Dana Okafor") and the
 *     Editing filter has something to count.
 *   - "Roadmap Timeline": one more editor, so the Shared / people surfaces aren't a one-off.
 */
import { loadConfig } from "@canvas-drop/shared";
import { sqliteSchema } from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import { makeDb } from "../src/db/factory.js";
import { runMigrations } from "../src/db/migrate.js";
import { canvasesRepository } from "../src/db/repositories/canvases.js";
import { invitationsRepository } from "../src/db/repositories/invitations.js";
import { teamsRepository } from "../src/db/repositories/teams.js";
import { usersRepository } from "../src/db/repositories/users.js";

const PEOPLE = {
  dana: { name: "Dana Okafor", email: "dana@example.com" },
  priya: { name: "Priya Nair", email: "priya@example.com" },
  liam: { name: "Liam Walsh", email: "liam@example.com" },
  sofia: { name: "Sofia Rossi", email: "sofia@example.com" },
  noah: { name: "Noah Kim", email: "noah@example.com" },
} as const;

async function main() {
  const config = loadConfig();
  if (config.db.driver !== "sqlite") {
    process.stderr.write("seed-collaborators targets the local SQLite dev DB only.\n");
    process.exit(1);
  }
  const dbClient = makeDb(config);
  await runMigrations(dbClient);
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam (sqlite in dev)
  const drizzle = dbClient.db as any;
  const t = sqliteSchema.canvases;

  const users = usersRepository(dbClient);
  const canvases = canvasesRepository(dbClient);
  const teams = teamsRepository(dbClient);
  const invitations = invitationsRepository(dbClient);

  const { email, name } = config.auth.dev;
  const admin = await users.upsert({ providerSub: `dev:${email}`, email, name, isAdmin: true });
  const person = async (p: { name: string; email: string }) =>
    users.upsert({ providerSub: `dev:${p.email}`, email: p.email, name: p.name, isAdmin: false });
  const dana = await person(PEOPLE.dana);
  const priya = await person(PEOPLE.priya);
  const liam = await person(PEOPLE.liam);
  const sofia = await person(PEOPLE.sofia);
  const noah = await person(PEOPLE.noah);

  // Look the demo apps up by their `<kebab-title>-demo` slug (seed-demo-apps): the volume
  // seed reuses some of the same titles, so a title lookup could hit a zero-file canvas.
  const bySlug = async (slug: string) => {
    const rows = (await drizzle.select().from(t).where(eq(t.slug, slug)).limit(1)) as Array<{
      id: string;
      ownerId: string;
    }>;
    const row = rows[0];
    if (!row) {
      process.stderr.write(`! no canvas with slug "${slug}" — run pnpm seed:demo-apps first\n`);
      return null;
    }
    return row;
  };

  const grant = async (
    canvasId: string,
    userId: string,
    role: "viewer" | "editor",
  ): Promise<void> => {
    const existing = await canvases.findMemberEntry(canvasId, userId);
    if (existing) {
      if (existing.role !== role) await canvases.setAllowlistRole(canvasId, existing.id, role);
      return;
    }
    await canvases.addAllowlistEntry({ canvasId, principalKind: "member", userId, role });
  };

  // ── Pricing Calculator: the full people-list story ──
  const pricing = await bySlug("pricing-calculator-demo");
  if (pricing) {
    await grant(pricing.id, priya.id, "editor");
    await grant(pricing.id, liam.id, "viewer");
    let design = (await teams.listForUser(admin.id)).find((tm) => tm.name === "Design") ?? null;
    if (!design) {
      design = await teams.create({ orgId: null, name: "Design", createdBy: admin.id });
      await teams.addMember(design.id, dana.id);
      await teams.addMember(design.id, sofia.id);
    }
    await teams.setCanvasTeamRole(pricing.id, design.id, "editor");
    const pending = await invitations.listForEmail("jordan@example.com");
    if (!pending.some((inv) => inv.targetType === "canvas" && inv.targetId === pricing.id)) {
      await invitations.record({
        email: "jordan@example.com",
        target: { type: "canvas", id: pricing.id },
        role: "editor",
        invitedBy: admin.id,
      });
    }
    process.stdout.write(
      "  ✓ Pricing Calculator: Priya (editor), Liam (viewer), Design team (editors), jordan@ pending editor\n",
    );
  }

  // ── Sprint Board: owned by Dana, the dev admin stays on as an editor ──
  const sprint = await bySlug("sprint-board-demo");
  if (sprint) {
    if (sprint.ownerId === admin.id) {
      const r = await canvases.transferOwner({
        canvasId: sprint.id,
        fromUserId: admin.id,
        toUserId: dana.id,
        previousOwnerEditor: true,
        revertPublicLink: false,
      });
      process.stdout.write(
        r.swapped
          ? "  ✓ Sprint Board: now owned by Dana Okafor; the dev admin is an editor\n"
          : "  ! Sprint Board: transfer did not apply (owner changed underneath)\n",
      );
    } else {
      await grant(sprint.id, admin.id, "editor");
      process.stdout.write("  ✓ Sprint Board: already re-homed; dev admin kept as editor\n");
    }
  }

  // ── Roadmap Timeline: one more editor ──
  const roadmap = await bySlug("roadmap-timeline-demo");
  if (roadmap) {
    await grant(roadmap.id, noah.id, "editor");
    process.stdout.write("  ✓ Roadmap Timeline: Noah (editor)\n");
  }

  process.stdout.write(
    "\nSeeded collaborators. Open Pricing Calculator → Share to see the people list.\n",
  );
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
