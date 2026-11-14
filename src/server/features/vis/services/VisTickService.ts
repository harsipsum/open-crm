import { VisRepository } from "@/server/features/vis/repositories/VisRepository";
import { AsanaHandoffService } from "@/server/features/vis/services/AsanaHandoffService";
import { OfflineConversionService } from "@/server/features/vis/services/OfflineConversionService";
import { ResearchService } from "@/server/features/vis/services/ResearchService";
import { SdrService } from "@/server/features/vis/services/SdrService";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { STAGE_ROLES, VISTAR_PIPELINE } from "@/shared/vis";

// What moves a VisCRM deal along without a person, every minute (cron.ts):
// SDR timers close and escalate; company research runs on a new lead;
// person research and the brief once it's qualified; the qualified-lead
// conversion once it reaches the qualified stage or beyond, and the purchase
// conversion and the Asana handoff once it's won. Every step is idempotent
// (one row per kind per deal), so a tick that runs twice does nothing twice.
// One deal failing doesn't stop the others.

async function tickOrganization(
  organizationId: string,
  origin: string | null,
  now: string,
) {
  const summary = {
    deals: 0,
    failed: 0,
    ...(await SdrService.tick(organizationId, now)),
  };
  const pipeline = await VisRepository.pipelineByName(
    organizationId,
    VISTAR_PIPELINE.name,
  );
  const qualifiedAt =
    pipeline?.stages.find(
      (stage) =>
        stage.name.toLowerCase() === STAGE_ROLES.qualified.toLowerCase(),
    )?.position ?? Number.POSITIVE_INFINITY;
  for (const row of await VisRepository.trackedDeals(organizationId)) {
    summary.deals += 1;
    try {
      const won = row.stageKind === "DONE";
      const lost = row.stageKind === "DROPPED";
      const qualified =
        won ||
        (!lost &&
          row.stagePosition !== null &&
          row.stagePosition >= qualifiedAt);
      await ResearchService.advance(organizationId, row.id, qualified);
      const lead = await VisRepository.attribution(organizationId, row.id);
      if (!lead || !qualified) continue;
      const people = await VisRepository.dealPeople(
        organizationId,
        row.id,
        lead.contactId,
      );
      const person = people[0] ?? null;
      await OfflineConversionService.emit(organizationId, {
        dealId: row.id,
        event: "QUALIFIED_LEAD",
        stageName: row.stageName ?? STAGE_ROLES.qualified,
        at: now,
        value: null,
        currency: null,
        lead,
        person,
      });
      if (!won) continue;
      await OfflineConversionService.emit(organizationId, {
        dealId: row.id,
        event: "PURCHASE",
        stageName: row.stageName ?? STAGE_ROLES.won,
        at: row.closedAt ?? now,
        value: row.amount,
        currency: row.currency,
        lead,
        person,
      });
      await AsanaHandoffService.handOff(organizationId, row.id, origin);
    } catch (error) {
      summary.failed += 1;
      console.error("[vis] tick failed for a deal", {
        organizationId,
        dealId: row.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return summary;
}

/** The cron's run over every organization with VisCRM leads. */
async function runDue(at: Date) {
  const origin = (await getOptionalEnvValue("VIS_CRM_ORIGIN")) ?? null;
  for (const organizationId of await VisRepository.organizationsWithLeads()) {
    const summary = await tickOrganization(
      organizationId,
      origin,
      at.toISOString(),
    );
    if (summary.escalated || summary.failed) {
      console.log("[vis] tick", { organizationId, ...summary });
    }
  }
}

export const VisTickService = { tickOrganization, runDue };
