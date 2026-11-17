import { beforeEach, describe, expect, it, vi } from "vitest";
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);
import { HubspotRepository } from "./HubspotRepository";

import { ensureUserRecord } from "@/middleware/ensure-user/delegated";
import { ActivityRepository } from "@/server/features/activities/repositories/ActivityRepository";

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
describe("HubSpot review regressions", () => {
  beforeEach(async () => {
    await database.exec('DELETE FROM organization; DELETE FROM "user";');
    await database.seedTwoOrganizations();
    vi.stubEnv("ASANA_WON_ENABLED", "0");
    vi.stubEnv("HUBSPOT_IMPORT_KEY", "synthetic-key-that-is-only-a-test");
    vi.stubEnv("EVERY_APP_ORG_ID", org);
    vi.stubGlobal("fetch", vi.fn());
  });
  it("moves imported owner assignments and ledger to the authenticated gateway identity", async () => {
    await seed();
    await ensureUserRecord("gateway-owner", "owner@example.test");
    expect(
      (await database.rows("select owner_id from deal"))[0]?.owner_id,
    ).toBe("gateway-owner");
    expect(
      (
        await database.rows(
          "select target_id from hubspot_object where object_type='owners'",
        )
      )[0]?.target_id,
    ).toBe("gateway-owner");
    expect(
      (
        await database.rows(
          "select user_id from member where id='hs:org_a:1234:members:7'",
        )
      )[0]?.user_id,
    ).toBe("gateway-owner");
    await seed();
    expect(
      (await database.rows("select owner_id from deal"))[0]?.owner_id,
    ).toBe("gateway-owner");
  });
  it("shows a multi-contact note on both timelines and hides it when archived", async () => {
    await seed();
    await HubspotRepository.writeObjects(org, {
      portalId,
      objectType: "contacts",
      records: [{ id: "6", properties: { firstname: "Second" } }],
    });
    await HubspotRepository.writeAssociations(org, {
      portalId,
      records: ["3", "6"].map((toId) => ({
        fromType: "notes",
        fromId: "5",
        toType: "contacts",
        toId,
        typeId: "202",
        category: "HUBSPOT_DEFINED",
        label: null,
      })),
    });
    for (const id of ["3", "6"]) {
      const record = {
        kind: "contact" as const,
        id: `hs:${org}:${portalId}:contacts:${id}`,
      };
      expect(
        (
          await ActivityRepository.timeline(org, {
            record,
            filter: "all",
            limit: 20,
          })
        ).entries,
      ).toHaveLength(1);
      expect((await ActivityRepository.counts(org, record)).all).toBe(1);
    }
    await HubspotRepository.writeObjects(org, {
      portalId,
      objectType: "notes",
      records: [
        {
          id: "5",
          archived: true,
          properties: { hs_note_body: "Archived synthetic" },
        },
      ],
    });
    const record = {
      kind: "contact" as const,
      id: `hs:${org}:${portalId}:contacts:3`,
    };
    expect(
      (
        await ActivityRepository.timeline(org, {
          record,
          filter: "all",
          limit: 20,
        })
      ).entries,
    ).toHaveLength(0);
    expect((await ActivityRepository.counts(org, record)).all).toBe(0);
    expect(
      await ActivityRepository.recent(org, { createdById: null, limit: 20 }),
    ).toHaveLength(0);
  });
});
