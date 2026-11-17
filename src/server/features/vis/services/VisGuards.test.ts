import { beforeEach, describe, expect, it, vi } from "vitest";

// The guards a review asked for: a resent submission doesn't make a second
// deal, someone deleted for good doesn't come back by themselves, a known
// contact keeps their own company, withdrawn consent sends no details, and
// research runs only once it is claimed.
const { database } = await vi.hoisted(async () => {
  const { createSqliteTestDb } = await import("@/server/testing/testDb");
  return { database: await createSqliteTestDb() };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: database.db }));
vi.mock("@/db/runBatch", () => database.runBatchModule);

import { VisRepository } from "../repositories/VisRepository";
import { VisWorkRepository } from "../repositories/VisWorkRepository";
import { IntakeService } from "./IntakeService";
import { VisDealService } from "./VisDealService";
import { VisTickService } from "./VisTickService";

/** A lead that must make (or join) a deal. */
async function newLead(...args: Parameters<typeof IntakeService.createLead>) {
  const created = await IntakeService.createLead(...args);
  if (!created.dealId) throw new Error("Expected a deal");
  return { ...created, dealId: created.dealId };
}

const A = "org_a";

const lead = {
  company: { name: "Synth Ports (synthetic)", domain: "synth-ports.example" },
  person: { firstName: "Omar", email: "omar@synth-ports.example" },
  attribution: {
    source: "WEB_FORM" as const,
    gclid: "synthetic-gclid-9",
    consent: "GRANTED" as const,
  },
  product: "ASANA" as const,
  amount: 12_000,
  currency: "AED" as const,
};

describe("VisCRM guards", () => {
  beforeEach(async () => {
    await database.exec(`
      DELETE FROM conversion_event; DELETE FROM asana_handoff; DELETE FROM deal_order;
      DELETE FROM sdr_timer; DELETE FROM deal_research; DELETE FROM deal_attribution;
      DELETE FROM activity; DELETE FROM deal_contact; DELETE FROM deal;
      DELETE FROM pipeline_stage; DELETE FROM pipeline; DELETE FROM contact; DELETE FROM company;
      DELETE FROM suppressed_contact; DELETE FROM suppressed_domain;
      DELETE FROM workspace; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";
    `);
    await database.seedTwoOrganizations();
    await database.exec(
      "INSERT INTO workspace (organization_id, name, deals_enabled) VALUES ('org_a', 'A', 1)",
    );
    await IntakeService.setupPipeline(A);
  });

  it("returns the same deal for a resent submission", async () => {
    const first = await newLead(
      A,
      { ...lead, externalRef: "chat-123" },
      "VISAGENT",
    );
    const again = await newLead(
      A,
      { ...lead, externalRef: "chat-123" },
      "VISAGENT",
    );
    expect(again).toMatchObject({ dealId: first.dealId, duplicate: true });
    expect(await database.rows("SELECT id FROM deal")).toHaveLength(1);
  });

  it("refuses someone deleted for good, and keeps a known contact at their own company", async () => {
    await database.exec(
      "INSERT INTO suppressed_contact (organization_id, email) VALUES ('org_a', 'gone@synth-ports.example')",
    );
    await expect(
      newLead(
        A,
        {
          ...lead,
          person: { firstName: "Gone", email: "gone@synth-ports.example" },
        },
        null,
      ),
    ).rejects.toThrow(/deleted from the CRM/);

    const first = await newLead(A, lead, null);
    const moved = await newLead(
      A,
      {
        ...lead,
        person: { ...lead.person, verified: ["email"] },
        company: { name: "Elsewhere (synthetic)", domain: "elsewhere.example" },
      },
      null,
    );
    expect(moved.companyId).toBe(first.companyId);
  });

  it("sends no personal details once consent is withdrawn", async () => {
    const created = await newLead(A, lead, null);
    await VisDealService.setConsent(A, {
      dealId: created.dealId,
      consent: "UNKNOWN",
    });
    await IntakeService.moveToStage(
      A,
      { dealId: created.dealId, stage: "SQL" },
      null,
    );
    await VisTickService.tickOrganization(A, null, new Date().toISOString());
    const sent = await VisWorkRepository.conversions(A, created.dealId);
    const google = sent.find((row) => row.platform === "GOOGLE");
    expect(google?.status).toBe("DRY_RUN");
    expect(JSON.stringify(google?.payload)).not.toContain("userData");
    // Meta and LinkedIn have no click id and may not use the email: skipped.
    expect(
      sent.filter((row) => row.platform !== "GOOGLE").map((row) => row.status),
    ).toEqual(["SKIPPED", "SKIPPED"]);
  });

  it("runs a research request only once it is claimed", async () => {
    const created = await newLead(A, lead, null);
    await VisWorkRepository.requestResearch(A, created.dealId, "COMPANY");
    expect(
      await VisWorkRepository.claimResearchRun(A, created.dealId, "COMPANY"),
    ).toBe(true);
    expect(
      await VisWorkRepository.claimResearchRun(A, created.dealId, "COMPANY"),
    ).toBe(false);
    expect(await VisRepository.attribution("org_b", created.dealId)).toBeNull();
  });
});
