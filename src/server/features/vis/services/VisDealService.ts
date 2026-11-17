import { z } from "zod";
import { DealService } from "@/server/features/deals/services/DealService";
import { VisRepository } from "@/server/features/vis/repositories/VisRepository";
import { VisWorkRepository } from "@/server/features/vis/repositories/VisWorkRepository";
import { AppError } from "@/server/lib/errors";
import { roundMoney } from "@/shared/currency";
import type { ConsentState } from "@/shared/vis";
import type { OrderInput } from "@/types/schemas/vis";

// A deal as Star CRM sees it: where the lead came from, its research and what
// it cost, the SDR's first call, the conversions it sent and its Asana task.
// The deal sheet's Lead tab and the tools read this one shape.

// The brief's sections as ResearchService writes them (a JSON column, read
// back through Zod).
const briefSchema = z.record(z.string(), z.string());

async function view(organizationId: string, dealId: string) {
  const found = await DealService.getDeal(organizationId, dealId);
  const [lead, research, timer, conversions, handoff, order] =
    await Promise.all([
      VisRepository.attribution(organizationId, dealId),
      VisWorkRepository.research(organizationId, dealId),
      VisWorkRepository.timer(organizationId, dealId),
      VisWorkRepository.conversions(organizationId, dealId),
      VisRepository.handoff(organizationId, dealId),
      VisRepository.order(organizationId, dealId),
    ]);
  const costUsd =
    Math.round(research.reduce((sum, row) => sum + row.costUsd, 0) * 10_000) /
    10_000;
  return {
    dealId,
    name: found.name,
    stage: found.pipelineStage ?? found.stage,
    lead,
    research: research.map((row) => ({
      kind: row.kind,
      status: row.status,
      provider: row.provider,
      tool: row.tool,
      costUsd: row.costUsd,
      summary: row.summary,
      error: row.error,
      filledByApp: row.filledByApp,
      requestedAt: row.requestedAt,
      completedAt: row.completedAt,
      brief:
        row.kind === "BRIEF"
          ? (briefSchema.safeParse(row.data).data ?? null)
          : null,
    })),
    costPerLeadUsd: costUsd,
    firstCall: timer,
    conversions: conversions.map((row) => ({
      platform: row.platform,
      event: row.event,
      status: row.status,
      clickId: row.clickId,
      value: row.value,
      currency: row.currency,
      // As it was (or would be) sent, as JSON text.
      payload: JSON.stringify(row.payload),
      response: row.response,
      createdAt: row.createdAt,
    })),
    asana: handoff,
    order,
  };
}

/** What was sold, from the accepted proposal: only what is given changes. */
async function setOrder(organizationId: string, input: OrderInput) {
  const found = await DealService.getDeal(organizationId, input.dealId);
  const { dealId, ...patch } = input;
  // Money is rounded to the deal currency's minor unit, as deal amounts are.
  const round = (value: number | undefined) =>
    value === undefined ? undefined : roundMoney(value, found.currency);
  await VisRepository.upsertOrder(organizationId, dealId, {
    ...patch,
    licenseRevenue: round(patch.licenseRevenue),
    implementationValue: round(patch.implementationValue),
  });
  return VisRepository.order(organizationId, dealId);
}

/**
 * The lead's consent, changed after intake (withdrawn, or given later). The
 * tick reads it fresh before every conversion, so a withdrawal stops any
 * event not yet sent from carrying the person's details.
 */
async function setConsent(
  organizationId: string,
  input: { dealId: string; consent: ConsentState },
) {
  await DealService.getDeal(organizationId, input.dealId);
  const lead = await VisRepository.attribution(organizationId, input.dealId);
  if (!lead) {
    throw new AppError("NOT_FOUND", "This deal has no Star CRM lead.");
  }
  await VisRepository.updateAttribution(organizationId, input.dealId, {
    consent: input.consent,
    consentAt: new Date().toISOString(),
  });
  return { dealId: input.dealId, consent: input.consent };
}

export const VisDealService = { view, setOrder, setConsent };
