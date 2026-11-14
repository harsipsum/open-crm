import { sortBy } from "remeda";
import { beforeEach, describe, expect, it, vi } from "vitest";

// VisCRM's lead-to-won flow against a real database: the intake sets the
// system fields and the SDR timer, the tick escalates once, research waits
// for its provider and takes the relay's answer once, a won deal records its
// conversions once per platform, and nothing crosses organizations.
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
import { KeyService } from "./KeyService";
import { ResearchService } from "./ResearchService";
import { VisTickService } from "./VisTickService";

/** A lead that must make (or join) a deal. */
async function newLead(...args: Parameters<typeof IntakeService.createLead>) {
  const created = await IntakeService.createLead(...args);
  if (!created.dealId) throw new Error("Expected a deal");
  return { ...created, dealId: created.dealId };
}

const A = "org_a";
const B = "org_b";

const lead = {
  company: {
    name: "Synth Holdings (synthetic)",
    domain: "synth-holdings.example",
  },
  person: {
    firstName: "Rana",
    lastName: "Synth",
    email: "rana@synth-holdings.example",
    title: "CFO",
  },
  attribution: {
    source: "GOOGLE_ADS" as const,
    campaign: "uae-einvoicing-asp",
    creativeId: "ad-031",
    gclid: "synthetic-gclid-1",
    consent: "GRANTED" as const,
  },
  product: "CLEARTAX" as const,
  qualifier: { country: "UAE", headcount: 650, erp: "SAP", timelineMonths: 3 },
  amount: 42_000,
  currency: "AED" as const,
};

describe("VisCRM flow", () => {
  beforeEach(async () => {
    await database.exec(`
      DELETE FROM conversion_event; DELETE FROM asana_handoff; DELETE FROM deal_order;
      DELETE FROM sdr_timer; DELETE FROM deal_research; DELETE FROM deal_attribution;
      DELETE FROM vis_app_key; DELETE FROM activity; DELETE FROM deal_contact; DELETE FROM deal;
      DELETE FROM pipeline_stage; DELETE FROM pipeline; DELETE FROM contact; DELETE FROM company;
      DELETE FROM workspace; DELETE FROM member; DELETE FROM organization; DELETE FROM "user";
    `);
    await database.seedTwoOrganizations();
    await database.exec(`
      INSERT INTO workspace (organization_id, name, deals_enabled)
        VALUES ('org_a', 'A', 1), ('org_b', 'B', 1);
    `);
    await IntakeService.setupPipeline(A);
  });

  it("sets the system fields and the 5-minute call at intake, and keeps them in their organization", async () => {
    const created = await newLead(A, lead, "VISAGENT");
    const attribution = await VisRepository.attribution(A, created.dealId);
    expect(attribution).toMatchObject({
      source: "GOOGLE_ADS",
      campaign: "uae-einvoicing-asp",
      gclid: "synthetic-gclid-1",
      product: "CLEARTAX",
      orderType: "NEW",
      createdByApp: "VISAGENT",
    });
    expect(attribution?.fitScore).toBe(100);
    const timer = await VisWorkRepository.timer(A, created.dealId);
    expect(timer?.status).toBe("OPEN");
    expect(
      Date.parse(timer?.dueAt ?? "") -
        Date.parse(attribution?.firstTouchAt ?? ""),
    ).toBeLessThanOrEqual(5 * 60_000 + 1000);

    expect(await VisRepository.attribution(B, created.dealId)).toBeNull();
    expect(await VisWorkRepository.timer(B, created.dealId)).toBeNull();
    expect(await VisWorkRepository.research(B, created.dealId)).toEqual([]);
    expect(await VisRepository.trackedDeals(B)).toEqual([]);
  });

  it("escalates an uncalled lead once at 24 hours, and never a called one", async () => {
    const late = await newLead(A, lead, null);
    const called = await newLead(
      A,
      {
        ...lead,
        person: { ...lead.person, email: "omar@synth-holdings.example" },
      },
      null,
    );
    await database.exec(
      `UPDATE activity SET completed_at = '2026-01-01T00:00:00.000Z' WHERE id = (SELECT task_activity_id FROM sdr_timer WHERE deal_id = '${called.dealId}')`,
    );
    const later = new Date(Date.now() + 25 * 3_600_000);
    const first = await VisTickService.tickOrganization(
      A,
      null,
      later.toISOString(),
    );
    const second = await VisTickService.tickOrganization(
      A,
      null,
      later.toISOString(),
    );
    expect(first.escalated).toBe(1);
    expect(second.escalated).toBe(0);
    expect((await VisWorkRepository.timer(A, late.dealId))?.status).toBe(
      "ESCALATED",
    );
    expect((await VisWorkRepository.timer(A, called.dealId))?.status).toBe(
      "DONE",
    );
  });

  it("waits for research without a provider, takes the relay's answer once, then writes the brief and the conversions once", async () => {
    const created = await newLead(A, lead, null);
    await IntakeService.moveToStage(
      A,
      { dealId: created.dealId, stage: "SQL" },
      null,
    );
    await VisTickService.tickOrganization(A, null, new Date().toISOString());
    const waiting = await VisWorkRepository.research(A, created.dealId);
    expect(waiting.map((row) => [row.kind, row.status])).toEqual([
      ["COMPANY", "PENDING"],
      ["PERSON", "PENDING"],
    ]);
    expect(waiting[0]?.error).toContain("COMPOSIO_API_KEY");

    for (const kind of ["COMPANY", "PERSON"] as const) {
      await ResearchService.fill(
        A,
        {
          dealId: created.dealId,
          kind,
          status: kind === "COMPANY" ? "DONE" : "NOT_FOUND",
          provider: "composio-instant",
          costUsd: kind === "COMPANY" ? 0.02 : 0,
        },
        "VISAGENT",
      );
    }
    await expect(
      ResearchService.fill(
        A,
        {
          dealId: created.dealId,
          kind: "COMPANY",
          status: "DONE",
          provider: "x",
          costUsd: 5,
        },
        "VISAGENT",
      ),
    ).rejects.toThrow(/already done/);

    await IntakeService.moveToStage(
      A,
      { dealId: created.dealId, stage: "Deal Won" },
      null,
    );
    await VisTickService.tickOrganization(A, null, new Date().toISOString());
    await VisTickService.tickOrganization(A, null, new Date().toISOString());
    const research = await VisWorkRepository.research(A, created.dealId);
    expect(research.find((row) => row.kind === "BRIEF")?.status).toBe("DONE");
    expect(research.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(
      0.02,
    );

    const sent = (await VisWorkRepository.conversions(A, created.dealId)).map(
      (row) => `${row.platform}:${row.event}:${row.status}`,
    );
    expect(sortBy(sent, (row) => row)).toEqual([
      "GOOGLE:PURCHASE:DRY_RUN",
      "GOOGLE:QUALIFIED_LEAD:DRY_RUN",
      // Consented email: matchable on Meta and LinkedIn without a click id.
      "LINKEDIN:PURCHASE:DRY_RUN",
      "LINKEDIN:QUALIFIED_LEAD:DRY_RUN",
      "META:PURCHASE:DRY_RUN",
      "META:QUALIFIED_LEAD:DRY_RUN",
    ]);
    expect(await VisWorkRepository.conversions(B, created.dealId)).toEqual([]);
  });

  it("refuses a key outside its scope or its pinned organization", async () => {
    const minted = await KeyService.mint(A, "VISPROPOSALS", "user_a");
    await expect(
      KeyService.authenticate(minted.key, "leads:write", A),
    ).rejects.toThrow(/can't leads write/);
    await expect(
      KeyService.authenticate(minted.key, "deals:read", B),
    ).rejects.toThrow(/not live/);
    expect(await KeyService.authenticate(minted.key, "deals:read", A)).toEqual({
      organizationId: A,
      app: "VISPROPOSALS",
    });
    const again = await KeyService.mint(A, "VISPROPOSALS", "user_a");
    await expect(
      KeyService.authenticate(minted.key, "deals:read", A),
    ).rejects.toThrow(/not live/);
    expect(
      (await KeyService.authenticate(again.key, "deals:read", A)).app,
    ).toBe("VISPROPOSALS");
  });
});
