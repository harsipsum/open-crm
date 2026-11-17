import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The same person on two channels: a web chat lead with email and phone,
// then a WhatsApp lead with the phone alone (typed differently), joins the
// open deal for that product instead of opening a second one; another
// product opens its own deal; the lookup finds them by either.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { phoneKey } from "@/shared/vis";
import { serveVisApi } from "../visApiRoute";
import { IntakeService } from "./IntakeService";
import { LeadMatchService } from "@/server/features/vis/services/LeadMatchService";
import { KeyService } from "./KeyService";

const A = "org_a";

const web = {
  company: {
    name: "Synth Freight (synthetic)",
    domain: "synth-freight.example",
  },
  person: {
    firstName: "Noor",
    email: "noor@synth-freight.example",
    phone: "+971 50 000 0042",
  },
  attribution: { source: "WEB_CHAT" as const },
  product: "CLEARTAX" as const,
};

describe("Star CRM matching", () => {
  beforeEach(async () => {
    await database.exec(`
      DELETE FROM sdr_timer; DELETE FROM deal_research; DELETE FROM deal_attribution;
      DELETE FROM activity; DELETE FROM deal_contact; DELETE FROM deal;
      DELETE FROM pipeline_stage; DELETE FROM pipeline; DELETE FROM contact; DELETE FROM company;
      DELETE FROM workspace; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";
    `);
    await database.seedTwoOrganizations();
    await database.exec(
      "INSERT INTO workspace (organization_id, name, deals_enabled) VALUES ('org_a', 'A', 1), ('org_b', 'B', 1)",
    );
    await IntakeService.setupPipeline(A);
  });

  it("serves create and lookup over the keyed API, by the key's scopes", async () => {
    const agent = await KeyService.mint(A, "VISAGENT", "user_a");
    const proposals = await KeyService.mint(A, "VISPROPOSALS", "user_a");
    const call = (path: string, key: string, body?: unknown) =>
      serveVisApi(
        new Request(`https://viscrm.example/api/vis/v1${path}`, {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json", "x-viscrm-key": key },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
    const created = await call("/leads", agent.key, web);
    expect(created.status).toBe(201);
    const refused = await call("/leads", proposals.key, web);
    expect(refused.status).toBe(403);
    const found = await call("/leads?phone=%2B971500000042", agent.key);
    expect(found.status).toBe(200);
    const { deals } = z
      .object({ deals: z.array(z.unknown()) })
      .parse(await found.json());
    expect(deals).toHaveLength(1);
    expect((await call("/leads", agent.key)).status).toBe(422);
  });

  it("reads phones as E.164", () => {
    expect(phoneKey("00971 50 000 0042")).toBe("+971500000042");
    expect(phoneKey("+971-50-000-0042")).toBe("+971500000042");
    expect(phoneKey("12345")).toBeNull();
  });

  it("writes nothing to a person matched only by an email someone typed", async () => {
    const first = await IntakeService.createLead(A, web, "VISAGENT");
    const notesBefore = await database.rows(
      "SELECT id FROM activity WHERE type = 'NOTE'",
    );
    const claimed = await IntakeService.createLead(
      A,
      {
        company: { name: "Anyone (synthetic)" },
        person: { firstName: "Impostor", email: "noor@synth-freight.example" },
        attribution: { source: "WEB_CHAT" },
        product: "CLEARTAX",
        note: "Please change my bank details.",
      },
      "VISAGENT",
    );
    expect(claimed).toMatchObject({
      dealId: null,
      possibleMatch: { matchedBy: "email", openDealIds: [first.dealId] },
    });
    expect(await database.rows("SELECT id FROM deal")).toHaveLength(1);
    expect(
      await database.rows("SELECT id FROM activity WHERE type = 'NOTE'"),
    ).toHaveLength(notesBefore.length);
  });

  it("joins a returning person's open deal by phone, and opens a new one for another product", async () => {
    const first = await IntakeService.createLead(A, web, "VISAGENT");
    const whatsapp = await IntakeService.createLead(
      A,
      {
        company: { name: "Unknown (WhatsApp)" },
        person: {
          firstName: "Noor",
          phone: "00971500000042",
          verified: ["phone"],
        },
        attribution: { source: "WHATSAPP", ctwaClid: "synthetic-ctwa" },
        product: "CLEARTAX",
      },
      "VISINBOX",
    );
    expect(whatsapp).toMatchObject({ dealId: first.dealId, existing: true });
    expect(await database.rows("SELECT id FROM deal")).toHaveLength(1);

    const asana = await IntakeService.createLead(
      A,
      {
        ...web,
        person: { ...web.person, verified: ["email"] },
        product: "ASANA",
      },
      "VISAGENT",
    );
    expect(asana.dealId).not.toBe(first.dealId);
    expect(asana.contactId).toBe(first.contactId);

    const byPhone = await LeadMatchService.lookup(A, {
      phone: "+971500000042",
    });
    expect(byPhone.contactId).toBe(first.contactId);
    expect(byPhone.deals.map((row) => row.product)).toEqual(
      expect.arrayContaining(["ASANA", "CLEARTAX"]),
    );
    expect(byPhone.deals).toHaveLength(2);
    expect(
      await LeadMatchService.lookup("org_b", { phone: "+971500000042" }),
    ).toEqual({
      contactId: null,
      deals: [],
    });
  });
});
