import { beforeEach, describe, expect, it, vi } from "vitest";

// Record scoping: who sees which deals, and the leaver handover that moves a
// book in one step.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { and, eq } from "drizzle-orm";
import { activity, deal } from "@/db/schema";
import { ActivityRepository } from "@/server/features/activities/repositories/ActivityRepository";
import { FieldValueRepository } from "@/server/features/fields/repositories/FieldValueRepository";
import {
  memberOf,
  type ImportRun,
} from "@/server/features/imports/services/importRun";
import { assertOwner } from "@/server/features/records/recordRules";
import {
  assertSeesAll,
  dealAccessCondition,
  resolveAccess,
  runWithAccess,
} from "./access";
import { TeamService } from "./TeamService";

const A = "org_a";

async function visibleDeals(userId: string, gatewayRole = "member") {
  const access = await resolveAccess({
    userId,
    organizationId: A,
    role: gatewayRole,
  });
  return runWithAccess(access, async () =>
    (
      await database.db
        .select({ id: deal.id })
        .from(deal)
        .where(and(eq(deal.organizationId, A), dealAccessCondition()))
        .orderBy(deal.id)
    ).map((row) => row.id),
  );
}

describe("record scoping", () => {
  beforeEach(async () => {
    await database.exec(`
      DELETE FROM audit_log; DELETE FROM crm_role; DELETE FROM activity;
      DELETE FROM deal_contact; DELETE FROM deal; DELETE FROM contact; DELETE FROM company;
      DELETE FROM workspace; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";
    `);
    await database.seedTwoOrganizations();
    await database.exec(`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
        ('mgr', 'Mia', 'mia@a.test', 1, 0, 0),
        ('s1', 'Sam', 'sam@a.test', 1, 0, 0),
        ('s2', 'Sol', 'sol@a.test', 1, 0, 0),
        ('old', 'Hubspot owner', 'old@a.test', 1, 0, 0);
      INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
        ('m_mgr', 'org_a', 'mgr', 'member', 0),
        ('m_s1', 'org_a', 's1', 'member', 0),
        ('m_s2', 'org_a', 's2', 'member', 0);
      INSERT INTO crm_role (organization_id, user_id, role, manager_id) VALUES
        ('org_a', 'mgr', 'manager', NULL),
        ('org_a', 's1', 'seller', 'mgr'),
        ('org_a', 's2', 'seller', NULL);
      INSERT INTO company (id, organization_id, name) VALUES ('acme', 'org_a', 'Acme');
      INSERT INTO deal (id, organization_id, name, company_id, owner_id) VALUES
        ('d_admin', 'org_a', 'Admin deal', 'acme', 'user_a'),
        ('d_mgr', 'org_a', 'Manager deal', 'acme', 'mgr'),
        ('d_s1', 'org_a', 'Seller one deal', 'acme', 's1'),
        ('d_s2', 'org_a', 'Seller two deal', 'acme', 's2'),
        ('d_pool', 'org_a', 'Pool deal', 'acme', 'old');
      INSERT INTO activity (id, organization_id, type, subject, company_id, deal_id, created_by_id, created_at, updated_at) VALUES
        ('t_s2', 'org_a', 'TASK', 'Call back', 'acme', 'd_s2', 's2', '2026-01-01', '2026-01-01');
    `);
  });

  it("shows sellers their own deals and the shared pool", async () => {
    expect(await visibleDeals("s1")).toEqual(["d_pool", "d_s1"]);
    expect(await visibleDeals("s2")).toEqual(["d_pool", "d_s2"]);
  });

  it("shows managers their team's deals, and admins every deal", async () => {
    expect(await visibleDeals("mgr")).toEqual(["d_mgr", "d_pool", "d_s1"]);
    expect(await visibleDeals("user_a", "owner")).toHaveLength(5);
  });

  it("puts a leaver's book in the shared pool, or hands it over in one step", async () => {
    await TeamService.setMemberLeft(A, "user_a", {
      userId: "s2",
      left: true,
      handTo: null,
    });
    expect(await visibleDeals("s1")).toEqual(["d_pool", "d_s1", "d_s2"]);

    await TeamService.setMemberLeft(A, "user_a", {
      userId: "s2",
      left: false,
      handTo: null,
    });
    const handed = await TeamService.setMemberLeft(A, "user_a", {
      userId: "s2",
      left: true,
      handTo: "s1",
    });
    expect(handed.moved).toEqual({ deals: 1, contacts: 0, tasks: 1 });
    const [task] = await database.db
      .select({ by: activity.createdById })
      .from(activity)
      .where(eq(activity.id, "t_s2"));
    expect(task?.by).toBe("s1");
    expect(await visibleDeals("s1")).toEqual(["d_pool", "d_s1", "d_s2"]);
    expect(await visibleDeals("mgr")).toContain("d_s2");
  });

  it("keeps a hidden deal's activity, fields and pipeline settings out of reach", async () => {
    const seller = await resolveAccess({
      userId: "s1",
      organizationId: A,
      role: "member",
    });
    const mgr = await resolveAccess({
      userId: "mgr",
      organizationId: A,
      role: "member",
    });
    await runWithAccess(seller, async () => {
      expect(await ActivityRepository.findById(A, "t_s2")).toBeNull();
      expect(await ActivityRepository.setCompleted(A, "t_s2", "now")).toBe(
        false,
      );
      expect(await FieldValueRepository.recordExists(A, "DEAL", "d_s2")).toBe(
        false,
      );
      expect(await FieldValueRepository.recordExists(A, "DEAL", "d_s1")).toBe(
        true,
      );
      expect(() => assertSeesAll()).toThrow();
    });
    await runWithAccess(mgr, () => expect(() => assertSeesAll()).toThrow());
    expect(await ActivityRepository.findById(A, "t_s2")).not.toBeNull();
  });

  it("stops a seller importing records for someone else", async () => {
    const run = {
      members: [
        { userId: "s1", name: "Sam", email: "sam@a.test" },
        { userId: "s2", name: "Sol", email: "sol@a.test" },
      ],
    } as ImportRun;
    const seller = await resolveAccess({
      userId: "s1",
      organizationId: A,
      role: "member",
    });
    runWithAccess(seller, () => {
      expect(memberOf(run, "sam@a.test")).toBe("s1");
      expect(() => memberOf(run, "sol@a.test")).toThrow(/Sellers own/);
    });
  });

  it("refuses to let a seller give a record to someone else", async () => {
    const seller = await resolveAccess({
      userId: "s1",
      organizationId: A,
      role: "member",
    });
    await expect(
      runWithAccess(seller, () => assertOwner(A, "s2")),
    ).rejects.toThrow(/Sellers own what they take/);
    await expect(
      runWithAccess(seller, () => assertOwner(A, "s1")),
    ).resolves.not.toThrow();
  });
});
