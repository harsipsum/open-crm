import { beforeEach, describe, expect, it, vi } from "vitest";

// A named stage's built-in stage comes from its name, never its place: a
// pipeline with more open stages than the buying ladder once pushed every
// later stage onto CONTRACT_SENT, and On Hold onto DECISION_MAKER_BOUGHT_IN.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { PipelineRepository } from "./PipelineRepository";

const A = "org_a";

// Vistar's HubSpot Sales Pipeline, in its own order.
const SALES_PIPELINE = [
  "Lead Generated",
  "Initial Meeting / Demo",
  "On Hold",
  "MQL",
  "SQL",
  "Technical Demo / POC / Integration Discussion",
  "Proposal Discussion / Budget Qualified",
  "Best Case",
  "Forecast Commit",
  "Deal Won",
  "Deal Lost",
];

describe("PipelineRepository built-in stages", () => {
  beforeEach(async () => {
    await database.exec(`
        DELETE FROM deal; DELETE FROM pipeline_stage; DELETE FROM pipeline; DELETE FROM company;
        DELETE FROM workspace; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";
      `);
    await database.seedTwoOrganizations();
  });

  it("maps a long pipeline's stages by name, On Hold to ON_HOLD and an unknown name to UNMAPPED", async () => {
    const pipelineId = await PipelineRepository.orderStages(
      A,
      "Sales Pipeline",
      SALES_PIPELINE,
    );
    const builtIn = async (name: string) =>
      (await PipelineRepository.ensureStage(A, pipelineId, name, "OPEN")).stage;

    expect({
      lead: await builtIn("Lead Generated"),
      demo: await builtIn("Initial Meeting / Demo"),
      onHold: await builtIn("On Hold"),
      mql: await builtIn("MQL"),
      sql: await builtIn("SQL"),
      technical: await builtIn("Technical Demo / POC / Integration Discussion"),
      proposal: await builtIn("Proposal Discussion / Budget Qualified"),
      bestCase: await builtIn("Best Case"),
      commit: await builtIn("Forecast Commit"),
      unknown: await builtIn("Waiting on Legal"),
    }).toEqual({
      lead: "LEAD",
      demo: "DEMO_BOOKED",
      onHold: "ON_HOLD",
      mql: "MQL",
      sql: "QUALIFIED_TO_BUY",
      technical: "TECHNICAL_EVALUATION",
      proposal: "PROPOSAL",
      bestCase: "BEST_CASE",
      commit: "COMMIT",
      unknown: "UNMAPPED",
    });
  });

  it("keeps an open deal's built-in stage when its stages are reordered", async () => {
    const pipelineId = await PipelineRepository.orderStages(
      A,
      "Sales Pipeline",
      SALES_PIPELINE,
    );
    const sql = await PipelineRepository.ensureStage(
      A,
      pipelineId,
      "SQL",
      "OPEN",
    );
    await database.exec(`
        INSERT INTO company (id, organization_id, name) VALUES ('acme', 'org_a', 'Acme');
        INSERT INTO deal (id, organization_id, name, company_id, owner_id, stage, pipeline_id, pipeline_stage_id)
          VALUES ('d1', 'org_a', 'Renewal', 'acme', 'user_a', 'CONTRACT_SENT', '${pipelineId}', '${sql.id}');
      `);

    await PipelineRepository.orderStages(A, "Sales Pipeline", [
      "SQL",
      ...SALES_PIPELINE.filter((name) => name !== "SQL"),
    ]);

    const [row] = await database.rows("SELECT stage FROM deal WHERE id = 'd1'");
    expect(row?.stage).toBe("QUALIFIED_TO_BUY");
  });
});
