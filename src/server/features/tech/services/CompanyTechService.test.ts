import { beforeEach, describe, expect, it, vi } from "vitest";

// A company's tech stack: one live line per product, team lines verified,
// email lines never show their source, and no organization reaches another's.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { companyTech } from "@/db/schema";
import { CompanyService } from "@/server/features/companies/services/CompanyService";
import { CompanyTechService } from "./CompanyTechService";

const A = "org_a";
const B = "org_b";

describe("CompanyTechService", () => {
  beforeEach(async () => {
    await database.exec(
      `DELETE FROM company_tech; DELETE FROM company; DELETE FROM workspace; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";`,
    );
    await database.seedTwoOrganizations();
  });

  it("keeps one live line per product, and a team line verifies an email one", async () => {
    const acme = await CompanyService.createCompany(A, { name: "Acme" });
    await database.db.insert(companyTech).values({
      id: "t_email",
      organizationId: A,
      companyId: acme.id,
      product: "Zoho Books",
      productKey: "zoho books",
      origin: "email",
      verified: false,
      source: "outlook:vineet@example.test:2026-11-02:msg-1",
      observedAt: "2026-11-02",
    });

    const [line] = await CompanyTechService.list(A, acme.id);
    expect(line).toMatchObject({ product: "Zoho Books", verified: false });
    // An email line's mailbox and message stay on the server.
    expect(line).not.toHaveProperty("source");
    expect(line?.publicUrl).toBeNull();

    const again = await CompanyTechService.add(A, "user_a", {
      companyId: acme.id,
      product: "  zoho   BOOKS ",
      origin: "team",
    });
    expect(again).toMatchObject({
      id: "t_email",
      created: false,
      verified: true,
      confirmedByName: "Ana",
    });
    expect(await CompanyTechService.list(A, acme.id)).toHaveLength(1);

    await CompanyTechService.archive(A, "user_a", "t_email");
    expect(await CompanyTechService.list(A, acme.id)).toHaveLength(0);
    // Archived, not deleted; and the product can be listed again.
    const rows = await database.db.select().from(companyTech);
    expect(rows).toHaveLength(1);
    await expect(
      CompanyTechService.add(A, "user_a", {
        companyId: acme.id,
        product: "Zoho Books",
        origin: "team",
      }),
    ).resolves.toMatchObject({ created: true, verified: true });
  });

  it("keeps each organization's stacks to itself", async () => {
    const acme = await CompanyService.createCompany(A, { name: "Acme" });
    const line = await CompanyTechService.add(A, "user_a", {
      companyId: acme.id,
      product: "SAP Business One",
      category: "ERP",
      origin: "public",
      source: "https://acme.example/careers",
    });
    expect(line).toMatchObject({ verified: false, publicHost: "acme.example" });

    await expect(CompanyTechService.list(B, acme.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      CompanyTechService.add(B, "user_b", {
        companyId: acme.id,
        product: "Tally",
        origin: "team",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      CompanyTechService.confirm(B, "user_b", line.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      CompanyTechService.archive(B, "user_b", line.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [still] = await CompanyTechService.list(A, acme.id);
    expect(still).toMatchObject({ verified: false, archivedAt: null });
  });
});
