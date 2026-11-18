import { beforeEach, describe, expect, it, vi } from "vitest";

// A member's first page load sends several requests at once, each of which
// may create their row; and a member the gateway removed and invited again
// comes back under a new id with the same email, which `user.email` keeps
// unique.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { loadTeam } from "@/server/features/access/access";
import { ensureUserRecord } from "./delegated";

describe("ensureUserRecord", () => {
  beforeEach(async () => {
    await database.exec(`DELETE FROM organization; DELETE FROM "user";`);
    await database.seedTwoOrganizations();
  });

  it("lets a re-invited member in under their new id however many first requests race; the old row keeps its membership and gives the email up", async () => {
    await Promise.all(
      [1, 2, 3].map(() => ensureUserRecord("user_a2", "ana@a.test")),
    );

    expect(
      await database.rows(
        `SELECT u.id, u.email, m.organization_id FROM "user" u LEFT JOIN member m ON m.user_id = u.id WHERE u.id IN ('user_a', 'user_a2') ORDER BY u.id`,
      ),
    ).toEqual([
      {
        id: "user_a",
        email: "user_a@replaced.invalid",
        organization_id: "org_a",
      },
      { id: "user_a2", email: "ana@a.test", organization_id: null },
    ]);
  });
  // A HubSpot owner placeholder in the rotation, holding a deal; the person
  // it stands for signs in for the first time as `vin`.
  async function seedPlaceholder() {
    await database.exec(`
      DELETE FROM crm_role; DELETE FROM deal; DELETE FROM company; DELETE FROM hubspot_object;
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
        ('hs:org_a:1:owners:1', 'Vin', 'vin@a.test', 0, 0, 0);
      INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
        ('m_vin', 'org_a', 'hs:org_a:1:owners:1', 'member', 0);
      INSERT INTO hubspot_object (organization_id, portal_id, object_type, source_id, target_id, data, imported_at) VALUES
        ('org_a', '1', 'owners', '1', 'hs:org_a:1:owners:1', '{}', '2026-11-01');
      INSERT INTO crm_role (organization_id, user_id, role, in_rotation) VALUES
        ('org_a', 'hs:org_a:1:owners:1', 'manager', 1);
      INSERT INTO company (id, organization_id, name) VALUES ('acme', 'org_a', 'Acme');
      INSERT INTO deal (id, organization_id, name, company_id, owner_id) VALUES
        ('d_lead', 'org_a', 'Web lead', 'acme', 'hs:org_a:1:owners:1');
    `);
  }

  it("moves a placeholder's leads to the person on first sign-in, and keeps them in the rotation", async () => {
    await seedPlaceholder();
    await ensureUserRecord("vin", "vin@a.test");
    expect(
      await database.rows(`SELECT owner_id FROM deal WHERE id = 'd_lead'`),
    ).toEqual([{ owner_id: "vin" }]);
    const team = await loadTeam("org_a");
    expect(team.find((row) => row.userId === "vin")).toMatchObject({
      role: "manager",
      inRotation: true,
    });
  });

  it("keeps the person's own rotation on first sign-in, over the placeholder's", async () => {
    await seedPlaceholder();
    await database.exec(
      `INSERT INTO crm_role (organization_id, user_id, role, in_rotation) VALUES ('org_a', 'vin', 'seller', 1);
       UPDATE crm_role SET in_rotation = 0 WHERE user_id = 'hs:org_a:1:owners:1';`,
    );
    await ensureUserRecord("vin", "vin@a.test");
    const team = await loadTeam("org_a");
    expect(team.find((row) => row.userId === "vin")).toMatchObject({
      role: "seller",
      inRotation: true,
    });
  });
});
