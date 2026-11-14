import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportChunkInput } from "@/types/schemas/imports";

// A HubSpot export with two pipelines, each with its own stage names: every
// deal lands in its pipeline at its stage, counts as the built-in stage of
// the same kind, and stays in its organization.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { DealService } from "@/server/features/deals/services/DealService";
import { ImportService } from "./ImportService";

const A = { organizationId: "org_a", userId: "user_a" };
const B = { organizationId: "org_b", userId: "user_b" };

function chunk(rows: Record<string, string>[]): ImportChunkInput {
  return {
    entity: "DEAL",
    duplicates: "skip",
    dryRun: false,
    rows: rows.map((values, index) => ({ line: index + 2, values })),
  };
}

const deal = (
  name: string,
  pipeline: string,
  stage: string,
  amount = "1000",
) => ({
  name,
  company: "acme.com",
  pipeline,
  stage,
  amount,
  currency: "AED",
  closeDate: "2026-10-02",
});

const outcomes = (result: { results: { outcome: string }[] }) =>
  result.results.map((row) => row.outcome);

describe("ImportService pipelines", () => {
  beforeEach(async () => {
    await database.exec(
      `DELETE FROM field_value; DELETE FROM activity; DELETE FROM deal; DELETE FROM pipeline_stage; DELETE FROM pipeline; DELETE FROM contact; DELETE FROM company; DELETE FROM workspace; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";`,
    );
    await database.seedTwoOrganizations();
  });

  it("lands each deal in its pipeline at its own stage", async () => {
    const rows = [
      deal("Lead", "Sales Pipeline", "Lead Generated"),
      deal("Demo", "Sales Pipeline", "Technical Demo/POC"),
      deal("Won", "Sales Pipeline", "Closed Won", "2500.50"),
      deal("Renewed", "Renewals", "Renewed"),
      deal("Churned", "Renewals", "Churned"),
      deal("Due", "Renewals", "Renewal Due"),
    ];
    expect(outcomes(await ImportService.importChunk(A, chunk(rows)))).toEqual(
      Array(6).fill("created"),
    );
    expect(
      await database.rows(
        `SELECT d.name, d.stage, p.name AS pipeline, s.name AS at, s.kind FROM deal d JOIN pipeline p ON p.id = d.pipeline_id JOIN pipeline_stage s ON s.id = d.pipeline_stage_id ORDER BY d.name`,
      ),
    ).toEqual([
      {
        name: "Churned",
        stage: "CLOSED_LOST",
        pipeline: "Renewals",
        at: "Churned",
        kind: "DROPPED",
      },
      {
        name: "Demo",
        stage: "QUALIFIED_TO_BUY",
        pipeline: "Sales Pipeline",
        at: "Technical Demo/POC",
        kind: "OPEN",
      },
      {
        name: "Due",
        stage: "DEMO_BOOKED",
        pipeline: "Renewals",
        at: "Renewal Due",
        kind: "OPEN",
      },
      {
        name: "Lead",
        stage: "DEMO_BOOKED",
        pipeline: "Sales Pipeline",
        at: "Lead Generated",
        kind: "OPEN",
      },
      {
        name: "Renewed",
        stage: "CLOSED_WON",
        pipeline: "Renewals",
        at: "Renewed",
        kind: "DONE",
      },
      {
        name: "Won",
        stage: "CLOSED_WON",
        pipeline: "Sales Pipeline",
        at: "Closed Won",
        kind: "DONE",
      },
    ]);

    // Re-run: nothing twice, no stage twice.
    expect(outcomes(await ImportService.importChunk(A, chunk(rows)))).toEqual(
      Array(6).fill("skipped"),
    );
    const pipelines = await DealService.listPipelines(A.organizationId);
    expect(
      pipelines.map((row) => [
        row.name,
        row.stages.map((stage) => [stage.name, stage.deals]),
      ]),
    ).toEqual([
      [
        "Sales Pipeline",
        [
          ["Lead Generated", 1],
          ["Technical Demo/POC", 1],
          ["Closed Won", 1],
        ],
      ],
      [
        "Renewals",
        [
          // First seen after the outcomes, still placed before them.
          ["Renewal Due", 1],
          ["Renewed", 1],
          ["Churned", 1],
        ],
      ],
    ]);
    expect(pipelines[0]?.stages[2]?.amountByCurrency).toEqual({ AED: 2500.5 });

    // Another organization neither sees them nor shares a pipeline by name.
    expect(await DealService.listPipelines(B.organizationId)).toEqual([]);
    await ImportService.importChunk(
      B,
      chunk([deal("B lead", "Renewals", "Renewal Due")]),
    );
    expect(
      (await DealService.listPipelines(A.organizationId))[1]?.stages[0]?.deals,
    ).toBe(1);
    expect(
      await database.rows(
        "SELECT organization_id FROM pipeline WHERE name = 'Renewals' ORDER BY organization_id",
      ),
    ).toEqual([{ organization_id: "org_a" }, { organization_id: "org_b" }]);
  });

  it("puts a pipeline's stages in its real order and re-counts open deals", async () => {
    // A HubSpot export lists deals, not stages: first sight is file order.
    await ImportService.importChunk(
      A,
      chunk([
        deal("Demo", "Sales Pipeline", "Technical Demo/POC"),
        deal("Won", "Sales Pipeline", "Closed Won"),
        deal("Lost", "Sales Pipeline", "Closed Lost"),
        deal("Best", "Sales Pipeline", "Best Case"),
        deal("Lead", "Sales Pipeline", "Lead Generated"),
        deal("Commit", "Sales Pipeline", "Forecast Commit"),
      ]),
    );
    const order = async () =>
      (await DealService.listPipelines(A.organizationId))[0]?.stages.map(
        (stage) => stage.name,
      );
    // Outcomes already land last; open stages in first-seen order.
    expect(await order()).toEqual([
      "Technical Demo/POC",
      "Best Case",
      "Lead Generated",
      "Forecast Commit",
      "Closed Won",
      "Closed Lost",
    ]);

    const real = [
      "Lead Generated",
      "Technical Demo/POC",
      "Best Case",
      "Forecast Commit",
      "Closed Won",
      "Closed Lost",
    ];
    const ordered = await DealService.orderPipelineStages(A.organizationId, {
      pipeline: "sales pipeline",
      stages: real,
    });
    expect(ordered.stages.map((stage) => [stage.name, stage.deals])).toEqual(
      real.map((name) => [name, 1]),
    );
    expect(await order()).toEqual(real);
    expect(
      await database.rows(
        "SELECT name, stage FROM deal WHERE organization_id = 'org_a' ORDER BY name",
      ),
    ).toEqual([
      { name: "Best", stage: "DECISION_MAKER_BOUGHT_IN" },
      { name: "Commit", stage: "CONTRACT_SENT" },
      { name: "Demo", stage: "QUALIFIED_TO_BUY" },
      { name: "Lead", stage: "DEMO_BOOKED" },
      { name: "Lost", stage: "CLOSED_LOST" },
      { name: "Won", stage: "CLOSED_WON" },
    ]);

    // A re-import neither adds a stage nor undoes the order.
    await ImportService.importChunk(
      A,
      chunk([deal("Lead", "Sales Pipeline", "Lead Generated")]),
    );
    expect(await order()).toEqual(real);

    // Another organization's pipeline of the same name is untouched.
    await ImportService.importChunk(
      B,
      chunk([
        deal("B won", "Sales Pipeline", "Closed Won"),
        deal("B lead", "Sales Pipeline", "Lead Generated"),
      ]),
    );
    await DealService.orderPipelineStages(A.organizationId, {
      pipeline: "Sales Pipeline",
      stages: ["Closed Lost", ...real.slice(0, 5)],
    });
    expect(
      (await DealService.listPipelines(B.organizationId))[0]?.stages.map(
        (stage) => stage.name,
      ),
    ).toEqual(["Lead Generated", "Closed Won"]);
  });

  it("moves a pipeline deal to its pipeline's won stage when won", async () => {
    await ImportService.importChunk(
      A,
      chunk([
        deal("Due", "Renewals", "Renewal Due"),
        deal("Other", "Renewals", "Renewed"),
      ]),
    );
    const [due] = await database.rows("SELECT id FROM deal WHERE name = 'Due'");
    const id = due?.id;
    if (typeof id !== "string") throw new Error("Imported deal missing");
    await DealService.setStage(
      A.organizationId,
      { id: id, stage: "CLOSED_WON" },
      A.userId,
    );
    expect(
      await database.rows(
        "SELECT d.stage, s.name AS at FROM deal d LEFT JOIN pipeline_stage s ON s.id = d.pipeline_stage_id WHERE d.name = 'Due'",
      ),
    ).toEqual([{ stage: "CLOSED_WON", at: "Renewed" }]);
  });
});
