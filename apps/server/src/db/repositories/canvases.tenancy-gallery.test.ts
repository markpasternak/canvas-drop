import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { seedListed, seedUser } from "./gallery-test-helpers.js";
import { orgsRepository } from "./orgs.js";

const NOW = 1_000_000;

/** Set a canvas's org_id + access directly (the cutover/settings paths aren't under test
 *  here — we just need rows in known tenancy states). */
async function setTenancy(
  client: DbClient,
  id: string,
  patch: { orgId?: string | null; access?: string },
) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect test seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;
  await db.update(t).set(patch).where(eq(t.id, id));
}

async function setDiscoverability(client: DbClient, id: string, discoverability: string) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect test seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;
  await db.update(t).set({ discoverability }).where(eq(t.id, id));
}

describe.each(DIALECTS)("gallery org-scope (plan 002 U5) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** Two real orgs, a public_link template (org_id null) + a whole_org template homed in
   *  org A, with DISTINCT tags so facet-scoping is observable. */
  async function seedOrgAndPublic() {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    const orgA = await orgs.ensureOrg({ name: "A", slug: "a", domains: ["a.example"] });
    const orgB = await orgs.ensureOrg({ name: "B", slug: "b", domains: ["b.example"] });
    const owner = await seedUser(client, "owner");
    const orgCanvas = await seedListed(client, owner.id, {
      galleryTemplatable: true,
      tags: ["org-only"],
    });
    await setTenancy(client, orgCanvas, { orgId: orgA.id, access: "whole_org" });
    const publicCanvas = await seedListed(client, owner.id, {
      galleryTemplatable: true,
      tags: ["public-tag"],
    });
    await setTenancy(client, publicCanvas, { orgId: null, access: "public_link" });
    return {
      repo: canvasesRepository(client),
      orgCanvas,
      publicCanvas,
      a: new Set([orgA.id]),
      b: new Set([orgB.id]),
    };
  }

  it("active tenancy: a member of org A sees both the org template and the public one", async () => {
    const { repo, orgCanvas, publicCanvas, a } = await seedOrgAndPublic();
    const { items } = await repo.listGallery({
      now: NOW,
      scope: { tenancyActive: true, viewerOrgIds: a },
      limit: 24,
      offset: 0,
    });
    expect(new Set(items.map((i) => i.canvas.id))).toEqual(new Set([orgCanvas, publicCanvas]));
  });

  it("active tenancy: a member of a DIFFERENT org B sees ZERO org-A canvases (only public)", async () => {
    const { repo, publicCanvas, b } = await seedOrgAndPublic();
    const { items } = await repo.listGallery({
      now: NOW,
      scope: { tenancyActive: true, viewerOrgIds: b },
      limit: 24,
      offset: 0,
    });
    expect(items.map((i) => i.canvas.id)).toEqual([publicCanvas]);
  });

  it("active tenancy: a guest/personal viewer (∅) sees only public_link, never an org gallery", async () => {
    const { repo, publicCanvas } = await seedOrgAndPublic();
    const { items } = await repo.listGallery({
      now: NOW,
      scope: { tenancyActive: true, viewerOrgIds: new Set() },
      limit: 24,
      offset: 0,
    });
    expect(items.map((i) => i.canvas.id)).toEqual([publicCanvas]);
  });

  it("inert tenancy (no scope): both are visible — legacy org-agnostic gallery", async () => {
    const { repo, orgCanvas, publicCanvas } = await seedOrgAndPublic();
    const { items } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    expect(new Set(items.map((i) => i.canvas.id))).toEqual(new Set([orgCanvas, publicCanvas]));
  });

  it("facets honor the same scope — a member of B never sees the org-A template's tag", async () => {
    const { repo, a, b } = await seedOrgAndPublic();
    const aFacets = await repo.listGalleryFacets(NOW, { tenancyActive: true, viewerOrgIds: a });
    const bFacets = await repo.listGalleryFacets(NOW, { tenancyActive: true, viewerOrgIds: b });
    expect(aFacets.tags).toEqual(expect.arrayContaining(["org-only", "public-tag"]));
    expect(bFacets.tags).toContain("public-tag");
    expect(bFacets.tags).not.toContain("org-only");
  });

  it("clone eligibility: an org-A template is NOT cloneable by a member of org B (404 seam)", async () => {
    const { repo, orgCanvas, publicCanvas, b } = await seedOrgAndPublic();
    const bScope = { tenancyActive: true, viewerOrgIds: b };
    expect(await repo.findCloneableTemplate(orgCanvas, NOW, bScope)).toBeNull();
    // …but the personal public_link template (org_id null) stays cloneable.
    expect((await repo.findCloneableTemplate(publicCanvas, NOW, bScope))?.id).toBe(publicCanvas);
  });

  it("clone eligibility: a guest (∅) cannot clone an org template", async () => {
    const { repo, orgCanvas } = await seedOrgAndPublic();
    expect(
      await repo.findCloneableTemplate(orgCanvas, NOW, {
        tenancyActive: true,
        viewerOrgIds: new Set(),
      }),
    ).toBeNull();
  });

  it("listed Whole-org gallery rows disappear when switched to link-only discovery", async () => {
    const { repo, orgCanvas, publicCanvas, a } = await seedOrgAndPublic();
    await setDiscoverability(client, orgCanvas, "link_only");
    const scope = { tenancyActive: true, viewerOrgIds: a };

    const { items } = await repo.listGallery({ now: NOW, scope, limit: 24, offset: 0 });
    expect(items.map((i) => i.canvas.id)).toEqual([publicCanvas]);

    const facets = await repo.listGalleryFacets(NOW, scope);
    expect(facets.tags).toContain("public-tag");
    expect(facets.tags).not.toContain("org-only");
    expect(await repo.findCloneableTemplate(orgCanvas, NOW, scope)).toBeNull();
  });
});
