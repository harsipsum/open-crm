import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// D1 refuses a LIKE pattern over 50 bytes, which made any search or "contains"
// filter of 49+ characters an internal error. Long terms match with instr()
// instead; both forms are case-insensitive and take % and _ literally.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { company } from "@/db/schema";
import { containsCondition } from "./listQuery";

const LONG =
  "Synthetic Gulf Logistics and Free Zone Holdings 100% Owned_Trading";

describe("containsCondition", () => {
  it("matches short and long terms alike, literally and case-insensitively", async () => {
    await database.seedTwoOrganizations();
    await database.exec(`
      INSERT INTO company (id, organization_id, name) VALUES
        ('long', 'org_a', '${LONG} LLC'), ('other', 'org_a', 'Synthetic Gulf Logistics');
    `);
    const ids = async (term: string) =>
      (
        await database.db
          .select({ id: company.id })
          .from(company)
          .where(
            and(
              eq(company.organizationId, "org_a"),
              containsCondition(company.name, term),
            ),
          )
          .orderBy(company.id)
      ).map((row) => row.id);

    expect(LONG.length).toBeGreaterThan(48);
    expect(await ids(LONG.toUpperCase())).toEqual(["long"]);
    expect(await ids("100% owned_trading")).toEqual(["long"]);
    expect(await ids("synthetic gulf")).toEqual(["long", "other"]);
    expect(await ids("100x owned")).toEqual([]);
  });
});
