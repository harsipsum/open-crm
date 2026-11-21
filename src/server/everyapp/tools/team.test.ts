import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The team and audit tools: a CRM admin sees each member's CRM role in
// list_members, changes it with update_member and reads the audit log, through
// the SDK's tools endpoint on real SQL, with the same CRM-admin check as
// Settings > Members and Settings > Audit log.
const { testDb } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { testDb: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => testDb.runBatchModule);

import {
  ana,
  bo,
  call,
  catalog,
  failure,
  idFrom,
  type Caller,
} from "@/server/everyapp/toolTestSupport";

const cy: Caller = {
  sub: "user_c",
  email: "cy@a.test",
  orgId: "org_a",
  orgRole: "member",
};
const di: Caller = {
  sub: "user_d",
  email: "di@a.test",
  orgId: "org_a",
  orgRole: "member",
};

const FORBIDDEN = "Only a CRM admin can do that.";
const readOnly = { scopes: ["mcp:read"] };

const members = z.object({
  members: z.array(
    z.object({
      id: z.string(),
      crm: z
        .object({ role: z.string(), managerId: z.string().nullable() })
        .nullable(),
    }),
  ),
});
const audit = z.object({
  rows: z.array(
    z.object({
      action: z.string(),
      actorEmail: z.string().nullable(),
      outcome: z.string(),
      detail: z.string(),
    }),
  ),
  more: z.boolean(),
});

const crmOf = async (caller: Caller, userId: string) =>
  members
    .parse(await call("list_members", {}, { as: caller }))
    .members.find((m) => m.id === userId)?.crm;

describe("team and audit tools", () => {
  beforeAll(async () => {
    await testDb.seedTwoOrganizations();
    // Their first calls make cy and di members of org_a, as the gateway does.
    await call("get_workspace", {}, { as: cy });
    await call("get_workspace", {}, { as: di });
  });

  it("lists update_member as a write and the log as a read", async () => {
    const { tools } = await catalog();
    const risk = new Map(tools.map((tool) => [tool.name, tool.risk]));
    expect(risk.get("update_member")).toBe("write");
    expect(risk.get("list_audit_log")).toBe("read");
    expect(risk.has("set_tracking_paused")).toBe(false);
  });

  it("a seller sees no CRM roles and is refused both, as on the screen", async () => {
    expect(await crmOf(cy, ana.sub)).toBeNull();
    expect(await failure("list_audit_log", {}, { as: cy })).toBe(FORBIDDEN);
    expect(
      await failure(
        "update_member",
        { userId: di.sub, role: "manager" },
        { as: cy },
      ),
    ).toBe(FORBIDDEN);
  });

  it("an owner sets roles and managers; a member made CRM admin then can too", async () => {
    expect(await crmOf(ana, ana.sub)).toMatchObject({ role: "admin" });
    expect(
      await call("update_member", { userId: cy.sub, role: "admin" }),
    ).toMatchObject({ role: "admin", managerId: null });
    expect(await crmOf(cy, cy.sub)).toMatchObject({ role: "admin" });
    expect(
      await call(
        "update_member",
        { userId: di.sub, role: "seller", managerId: cy.sub },
        { as: cy },
      ),
    ).toMatchObject({ role: "seller", managerId: cy.sub });
    // Only what is given changes: the manager stays.
    expect(
      await call("update_member", { userId: di.sub, role: "manager" }),
    ).toMatchObject({ role: "manager", managerId: cy.sub });
    expect(
      await failure("update_member", { userId: ana.sub, role: "seller" }),
    ).toContain("Change their role on Star OS");
  });

  it("marks a leaver and back without handing their book over, in its own organization only", async () => {
    const companyId = await idFrom(
      "create_company",
      { name: "Kept", ownerEmail: di.email },
      { as: ana },
    );
    const marked = await call("update_member", { userId: di.sub, left: true });
    expect(marked.leftAt).toBeTypeOf("string");
    expect(
      await call("get_company", { id: companyId }, { as: cy }),
    ).toMatchObject({ owner: { email: di.email } });
    expect(
      await call("update_member", { userId: di.sub, left: false }),
    ).toMatchObject({ leftAt: null });
    expect(
      await failure("update_member", {
        userId: di.sub,
        left: true,
        handTo: ana.sub,
      }),
    ).toMatch(/handTo/);
    expect(
      await failure(
        "update_member",
        { userId: di.sub, left: true },
        { as: bo },
      ),
    ).toContain("isn't in this workspace");
  });

  it("refuses a leaver mark sent with a role or manager change, and changes nothing", async () => {
    // cy is a CRM admin from the tests above and a plain Gateway member, so
    // marking themself left is refused; the role in the same call must not
    // stick either.
    const before = await crmOf(ana, cy.sub);
    expect(before).toMatchObject({ role: "admin" });
    expect(
      await failure(
        "update_member",
        { userId: cy.sub, role: "seller", left: true },
        { as: cy },
      ),
    ).toContain("in a call of its own");
    expect(
      await failure(
        "update_member",
        { userId: cy.sub, managerId: null, left: false },
        { as: cy },
      ),
    ).toContain("in a call of its own");
    expect(
      await failure(
        "update_member",
        { userId: cy.sub, left: true },
        { as: cy },
      ),
    ).toBe("Another admin marks you as left.");
    expect(await crmOf(ana, cy.sub)).toEqual(before);
  });

  it("the audit log names who called each tool; a read-only connection reads it; another organization sees none of it", async () => {
    const { rows } = audit.parse(
      await call("list_audit_log", {}, { ...readOnly, as: cy }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        action: "tool:update_member",
        actorEmail: cy.email,
        outcome: "ok",
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        action: "tool:update_member",
        actorEmail: ana.email,
        detail: JSON.stringify({ userId: di.sub, left: true }),
      }),
    );
    expect(
      await failure(
        "update_member",
        { userId: di.sub, role: "seller" },
        readOnly,
      ),
    ).not.toBe("");
    const other = audit.parse(await call("list_audit_log", {}, { as: bo }));
    expect(other.rows).toEqual([
      expect.objectContaining({ actorEmail: bo.email, outcome: "error" }),
    ]);
  });
});
