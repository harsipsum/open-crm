import { beforeEach, describe, expect, it, vi } from "vitest";
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);
import { HubspotRepository } from "./HubspotRepository";
import { serveHubspotImport } from "./hubspotRoute";
import { DealService } from "@/server/features/deals/services/DealService";
import { AsanaHandoffService } from "@/server/features/vis/services/AsanaHandoffService";

const portalId = "1234";
const org = "org_a";
async function seed() {
  await HubspotRepository.writeObjects(org, {
    portalId,
    objectType: "owners",
    records: [{ id: "7", firstName: "Test", email: "owner@example.test" }],
  });
  await HubspotRepository.writeObjects(org, {
    portalId,
    objectType: "pipelines",
    records: [{ id: "default", label: "Sales Pipeline" }],
  });
  await HubspotRepository.writeObjects(org, {
    portalId,
    objectType: "stages",
    records: [
      {
        id: "default:won",
        pipelineId: "default",
        label: "Deal Won",
        stageKind: "DONE",
        builtInStage: "CLOSED_WON",
      },
    ],
  });
  await HubspotRepository.writeObjects(org, {
    portalId,
    objectType: "companies",
    records: [
      {
        id: "1",
        properties: {
          name: "Synthetic company",
          domain: "example.test",
          strange_custom_property: "kept",
        },
      },
      {
        id: "2",
        properties: { name: "Duplicate domain", domain: "example.test" },
      },
    ],
  });
  await HubspotRepository.writeObjects(org, {
    portalId,
    objectType: "contacts",
    records: [
      {
        id: "3",
        properties: {
          firstname: "Synthetic",
          email: "person@example.test",
          phone: "+10000000001",
        },
      },
    ],
  });
  await HubspotRepository.writeObjects(org, {
    portalId,
    objectType: "deals",
    records: [
      {
        id: "4",
        createdAt: "2020-01-02T00:00:00Z",
        properties: {
          dealname: "Historical win",
          pipeline: "default",
          dealstage: "won",
          amount: "1000",
          closedate: "2020-03-04T00:00:00Z",
          hubspot_owner_id: "7",
        },
      },
    ],
  });
  await HubspotRepository.writeObjects(org, {
    portalId,
    objectType: "notes",
    records: [{ id: "5", properties: { hs_note_body: "Synthetic note" } }],
  });
}
describe("HubSpot migration data path", () => {
  beforeEach(async () => {
    await database.exec('DELETE FROM organization; DELETE FROM "user";');
    await database.seedTwoOrganizations();
    vi.stubEnv("ASANA_WON_ENABLED", "0");
    vi.stubEnv("HUBSPOT_IMPORT_KEY", "synthetic-key-that-is-only-a-test");
    vi.stubEnv("EVERY_APP_ORG_ID", org);
    vi.stubGlobal("fetch", vi.fn());
  });
  it("preserves custom properties, historical dates and duplicate domains, with zero new objects on replay", async () => {
    await seed();
    const before = await HubspotRepository.counts(org, portalId);
    await seed();
    expect(await HubspotRepository.counts(org, portalId)).toEqual(before);
    expect(before.projections).toEqual({
      companies: 2,
      contacts: 1,
      deals: 1,
      notes: 1,
    });
    expect(
      (await database.rows("select count(*) as n from asana_won_queue"))[0]?.n,
    ).toBe(0);
    expect(
      (await database.rows("select closed_at from deal"))[0]?.closed_at,
    ).toBe("2020-03-04T00:00:00.000Z");
    expect(
      (
        await database.rows(
          "select json_extract(data,'$.properties.strange_custom_property') as v from hubspot_object where object_type='companies' and source_id='1'",
        )
      )[0]?.v,
    ).toBe("kept");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps every labelled association and projects the company and deal contacts", async () => {
    await seed();
    const records = [
      {
        fromType: "contacts",
        fromId: "3",
        toType: "companies",
        toId: "1",
        typeId: "1",
        category: "HUBSPOT_DEFINED",
        label: "Primary",
      },
      {
        fromType: "contacts",
        fromId: "3",
        toType: "companies",
        toId: "2",
        typeId: "99",
        category: "USER_DEFINED",
        label: "Secondary",
      },
      {
        fromType: "deals",
        fromId: "4",
        toType: "companies",
        toId: "1",
        typeId: "5",
        category: "HUBSPOT_DEFINED",
        label: "Primary",
      },
      {
        fromType: "deals",
        fromId: "4",
        toType: "contacts",
        toId: "3",
        typeId: "3",
        category: "HUBSPOT_DEFINED",
        label: null,
      },
      {
        fromType: "notes",
        fromId: "5",
        toType: "deals",
        toId: "4",
        typeId: "214",
        category: "HUBSPOT_DEFINED",
        label: null,
      },
    ] as const;
    await HubspotRepository.writeAssociations(org, {
      portalId,
      records: [...records],
    });
    await HubspotRepository.writeAssociations(org, {
      portalId,
      records: [...records],
    });
    expect((await HubspotRepository.counts(org, portalId)).associations).toBe(
      5,
    );
    expect(
      (await database.rows("select count(*) as n from deal_contact"))[0]?.n,
    ).toBe(1);
    expect(
      (await database.rows("select company_id from contact"))[0]?.company_id,
    ).toBe("hs:org_a:1234:companies:1");
    expect(
      (await HubspotRepository.counts("org_b", portalId)).projections,
    ).toEqual({ companies: 0, contacts: 0, deals: 0, notes: 0 });
  });
  it("never sends historical wins even if delivery is enabled; a fresh Won transition queues once", async () => {
    await seed();
    const id = "hs:org_a:1234:deals:4";
    vi.stubEnv("ASANA_WON_ENABLED", "1");
    expect(await AsanaHandoffService.handOff(org, id, null)).toBeNull();
    await DealService.setStage(org, { id, stage: "DEMO_BOOKED" }, "user_a");
    await DealService.setStage(org, { id, stage: "CLOSED_WON" }, "user_a");
    await DealService.setStage(org, { id, stage: "CLOSED_WON" }, "user_a");
    expect(
      (await database.rows("select count(*) as n from asana_won_queue"))[0]?.n,
    ).toBe(1);
    vi.stubEnv("ASANA_WON_ENABLED", "0");
    expect(await AsanaHandoffService.retry(org, id, null)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a missing or wrong key before reading or writing any records", async () => {
    const response = await serveHubspotImport(
      new Request("https://crm.example.test/api/vis/v1/hubspot/objects", {
        method: "POST",
        headers: { "x-hubspot-import-key": "wrong" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
    expect((await HubspotRepository.counts(org, portalId)).objects).toEqual([]);
  });
});
