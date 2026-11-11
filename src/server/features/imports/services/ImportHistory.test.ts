import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportChunkInput } from "@/types/schemas/imports";

// CSV import of a CRM export: what the source CRM recorded (when a deal
// closed and why, when a record was created, its currency) comes through, so
// reports count history in the months it happened.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { ImportService } from "./ImportService";

const A = { organizationId: "org_a", userId: "user_a" };

function chunk(
  entity: ImportChunkInput["entity"],
  rows: Record<string, string>[],
  options: Partial<ImportChunkInput> = {},
): ImportChunkInput {
  return {
    entity,
    duplicates: "skip",
    dryRun: false,
    rows: rows.map((values, index) => ({ line: index + 2, values })),
    ...options,
  };
}

const outcomes = (result: { results: { outcome: string }[] }) =>
  result.results.map((row) => row.outcome);

describe("ImportService history", () => {
  beforeEach(async () => {
    await database.exec(
      `DELETE FROM field_value; DELETE FROM activity; DELETE FROM deal; DELETE FROM contact; DELETE FROM company; DELETE FROM workspace; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";`,
    );
    await database.seedTwoOrganizations();
  });

  it("keeps a HubSpot export's history: close and create dates, lost reasons, AED", async () => {
    const deals: Record<string, string>[] = [
      {
        name: "Won in September",
        company: "acme.com",
        stage: "Closed Won",
        amount: "AED 18,365.00",
        currency: "aed",
        closeDate: "2026-09-14 10:23",
        createdAt: "2026-07-01 08:00",
      },
      {
        name: "Lost in October",
        company: "acme.com",
        stage: "Closed Lost",
        amount: "4000",
        currency: "SAR",
        closeDate: "2026-10-02",
        lostReason: "Went with a reseller",
      },
      {
        name: "Still open",
        company: "acme.com",
        stage: "Contract sent",
        closeDate: "2027-01-31",
      },
    ];
    expect(
      outcomes(await ImportService.importChunk(A, chunk("DEAL", deals))),
    ).toEqual(["created", "created", "created"]);
    expect(
      await database.rows(
        "SELECT name, currency, amount, closed_at, stage_changed_at, closed_reason, created_at FROM deal WHERE organization_id = 'org_a' ORDER BY name",
      ),
    ).toMatchObject([
      {
        name: "Lost in October",
        currency: "SAR",
        amount: 4000,
        closed_at: "2026-10-02T00:00:00.000Z",
        closed_reason: "Went with a reseller",
      },
      { name: "Still open", closed_at: null, closed_reason: null },
      {
        name: "Won in September",
        currency: "AED",
        amount: 18365,
        closed_at: "2026-09-14T00:00:00.000Z",
        stage_changed_at: "2026-09-14T00:00:00.000Z",
        created_at: "2026-07-01T08:00:00.000Z",
      },
    ]);
    // Re-run: the same file creates nothing twice.
    expect(
      outcomes(await ImportService.importChunk(A, chunk("DEAL", deals))),
    ).toEqual(["skipped", "skipped", "skipped"]);

    const contacts = await ImportService.importChunk(
      A,
      chunk("CONTACT", [
        { email: "old@acme.com", firstName: "Old", createdAt: "2024-02-29" },
        { email: "bad@acme.com", firstName: "Bad", createdAt: "yesterday" },
      ]),
    );
    expect(outcomes(contacts)).toEqual(["created", "failed"]);
    expect(
      await database.rows(
        "SELECT created_at FROM contact WHERE email = 'old@acme.com'",
      ),
    ).toEqual([{ created_at: "2024-02-29T00:00:00.000Z" }]);
  });
});
