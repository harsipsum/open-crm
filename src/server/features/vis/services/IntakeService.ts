import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { loadTeam } from "@/server/features/access/access";
import { ActivityRepository } from "@/server/features/activities/repositories/ActivityRepository";
import { CompanyService } from "@/server/features/companies/services/CompanyService";
import { ContactService } from "@/server/features/contacts/services/ContactService";
import { DealContactRepository } from "@/server/features/deals/repositories/DealContactRepository";
import { PipelineRepository } from "@/server/features/deals/repositories/PipelineRepository";
import { DealService } from "@/server/features/deals/services/DealService";
import { WorkspaceService } from "@/server/features/workspace/services/WorkspaceService";
import { fitScore } from "@/server/features/vis/fitScore";
import { VisRepository } from "@/server/features/vis/repositories/VisRepository";
import { LeadMatchService } from "@/server/features/vis/services/LeadMatchService";
import { SdrService } from "@/server/features/vis/services/SdrService";
import { AppError } from "@/server/lib/errors";
import { OPEN_DEAL_STAGES } from "@/shared/deal-stages";
import { normalizeDomain } from "@/shared/domain";
import {
  INBOUND_SOURCES,
  phoneKey,
  PRODUCT_LABELS,
  STAGE_ROLES,
  VISTAR_PIPELINE,
  type VisApp,
} from "@/shared/vis";
import type { LeadInput } from "@/types/schemas/vis";

// A lead from any channel becomes a company, a contact and a deal at the
// intake stage of the Sales Pipeline, with its source, campaign, creative,
// click ids, consent, product and fit score set by the system at first
// touch. Inbound leads get the SDR's 5-minute call task on creation; the
// research and everything after it run on the tick (VisTickService).

/** Vistar's pipeline, in HubSpot's order; safe to run again. */
async function setupPipeline(organizationId: string) {
  await WorkspaceService.requireDealsEnabled(organizationId);
  return DealService.orderPipelineStages(organizationId, {
    pipeline: VISTAR_PIPELINE.name,
    stages: [...VISTAR_PIPELINE.stages],
  });
}

async function requirePipeline(organizationId: string) {
  const found = await VisRepository.pipelineByName(
    organizationId,
    VISTAR_PIPELINE.name,
  );
  if (!found || found.stages.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The ${VISTAR_PIPELINE.name} isn't set up yet: run vis_setup_pipeline first.`,
    );
  }
  return found;
}

/**
 * The owner a new lead goes to on arrival: the member named (unless they
 * left), else whichever working seller holds the fewest Star CRM leads. With
 * no sellers set up yet, the round robin runs over every working member.
 */
async function ownerFor(organizationId: string, ownerEmail?: string) {
  const [members, team] = await Promise.all([
    AuthRepository.listMembers(organizationId),
    loadTeam(organizationId),
  ]);
  const left = new Set(
    team.filter((row) => row.leftAt).map((row) => row.userId),
  );
  const working = members.filter((member) => !left.has(member.userId));
  if (working.length === 0) {
    throw new AppError("VALIDATION_ERROR", "The CRM has no working members.");
  }
  if (ownerEmail) {
    const named = members.find(
      (member) => member.email.toLowerCase() === ownerEmail.toLowerCase(),
    );
    if (!named) {
      throw new AppError("VALIDATION_ERROR", `No member is ${ownerEmail}.`);
    }
    if (!left.has(named.userId)) return named.userId;
  }
  const sellers = new Set(
    team.filter((row) => row.role === "seller").map((row) => row.userId),
  );
  const pool = working.some((member) => sellers.has(member.userId))
    ? working.filter((member) => sellers.has(member.userId))
    : working;
  const deals = await VisRepository.trackedDeals(organizationId);
  const load = new Map(pool.map((member) => [member.userId, 0]));
  for (const row of deals) {
    if (load.has(row.ownerId))
      load.set(row.ownerId, (load.get(row.ownerId) ?? 0) + 1);
  }
  let pick = pool[0].userId;
  for (const [userId, count] of load) {
    if (count < (load.get(pick) ?? 0)) pick = userId;
  }
  return pick;
}

async function companyFor(
  organizationId: string,
  input: LeadInput,
  ownerId: string,
  known: { companyId: string | null } | null,
) {
  // A person the CRM already knows stays at their own company: the deal
  // goes there, never to a second company a form named.
  if (known?.companyId) return known.companyId;
  const domain = normalizeDomain(input.company.domain ?? "") || null;
  if (domain) {
    const found = await VisRepository.liveCompanyByDomain(
      organizationId,
      domain,
    );
    if (found) return found.id;
  }
  const created = await CompanyService.createCompany(organizationId, {
    name: input.company.name,
    domain: domain ?? undefined,
    ownerId,
  });
  return created.id;
}

async function contactFor(
  organizationId: string,
  input: LeadInput,
  companyId: string,
  ownerId: string,
  known: { id: string } | null,
) {
  if (known) return known.id;
  const email = input.person.email?.trim().toLowerCase();
  const created = await ContactService.createContact(organizationId, {
    firstName: input.person.firstName,
    lastName: input.person.lastName,
    email,
    // Stored as E.164 so a WhatsApp sender matches it later.
    phone: phoneKey(input.person.phone) ?? input.person.phone,
    title: input.person.title,
    companyId,
    ownerId,
  });
  return created.id;
}

/** Creates the lead's company, contact and deal; returns the deal. */
async function createLead(
  organizationId: string,
  input: LeadInput,
  app: VisApp | null,
) {
  await WorkspaceService.requireDealsEnabled(organizationId);
  // The same submission sent again (a retry after a lost answer) gets the
  // deal it already made, not a second one.
  if (input.externalRef) {
    const earlier = await VisRepository.attributionByRef(
      organizationId,
      app,
      input.externalRef,
    );
    if (earlier) {
      return {
        dealId: earlier.dealId,
        companyId: null,
        contactId: earlier.contactId,
        ownerId: null,
        fitScore: earlier.fitScore,
        duplicate: true,
      };
    }
  }
  const email = input.person.email?.trim().toLowerCase() ?? null;
  const domain =
    normalizeDomain(input.company.domain ?? "") ||
    (email ? normalizeDomain(email.split("@")[1] ?? "") : "") ||
    null;
  // Someone deleted forever doesn't come back by themselves: a person adds
  // them by hand if they should.
  if (await VisRepository.isSuppressed(organizationId, email, domain)) {
    throw new AppError(
      "CONFLICT",
      "This person or domain was deleted from the CRM for good; only a person can add them back.",
    );
  }
  const pipeline = await requirePipeline(organizationId);
  const known = await LeadMatchService.knownPerson(
    organizationId,
    email,
    input.person.phone,
  );
  // Anyone can type someone else's email into a chat: a match only counts
  // when the sending app says the channel proved that identifier (a WhatsApp
  // sender's phone, an email confirmed by a code). Otherwise nothing is
  // written to that person's records; the app gets the possible match for a
  // person to review.
  if (known && !input.person.verified?.includes(known.matchedBy)) {
    const open = await VisRepository.leadDeals(organizationId, known.id, true);
    return {
      dealId: null,
      companyId: null,
      contactId: null,
      ownerId: null,
      fitScore: null,
      duplicate: false,
      existing: false,
      possibleMatch: {
        matchedBy: known.matchedBy,
        openDealIds: open.map((row) => row.dealId),
      },
    };
  }
  // The same person back on another channel (web chat, then WhatsApp) joins
  // their open deal for this product instead of opening a second one.
  if (known) {
    const open = await LeadMatchService.openDealFor(
      organizationId,
      known.id,
      input,
    );
    if (open) {
      await addNote(
        organizationId,
        open.dealId,
        [
          `Came back via ${input.attribution.source}${input.attribution.campaign ? ` (${input.attribution.campaign})` : ""}.`,
          input.note,
        ]
          .filter(Boolean)
          .join("\n"),
        app,
      );
      return {
        dealId: open.dealId,
        companyId: known.companyId,
        contactId: known.id,
        ownerId: null,
        fitScore: open.fitScore,
        duplicate: false,
        existing: true,
      };
    }
  }
  const ownerId = await ownerFor(organizationId, input.ownerEmail);
  const companyId = await companyFor(organizationId, input, ownerId, known);
  const contactId = await contactFor(
    organizationId,
    input,
    companyId,
    ownerId,
    known,
  );
  const productLabel = input.product ? PRODUCT_LABELS[input.product] : "Lead";
  const created = await DealService.createDeal(organizationId, {
    name: input.dealName ?? `${input.company.name}: ${productLabel}`,
    companyId,
    ownerId,
    stage: "DEMO_BOOKED",
    amount: input.amount ?? null,
    currency: input.currency,
  });
  await DealContactRepository.attach(organizationId, {
    dealId: created.id,
    contactId,
    role: "Lead",
  });
  const intake = await PipelineRepository.ensureStage(
    organizationId,
    pipeline.id,
    STAGE_ROLES.intake,
    "OPEN",
  );
  await PipelineRepository.place(organizationId, created.id, intake);

  const now = new Date().toISOString();
  const row = attributionRow(input, app, now);
  await VisRepository.insertAttribution({
    ...row,
    dealId: created.id,
    organizationId,
    contactId,
  });
  if (input.note) {
    await addNote(organizationId, created.id, input.note, app);
  }
  if (INBOUND_SOURCES.includes(row.source)) {
    await SdrService.startFirstCall(organizationId, {
      dealId: created.id,
      contactId,
      ownerId,
      createdAt: now,
    });
  }
  console.log("[vis] lead created", {
    organizationId,
    dealId: created.id,
    source: row.source,
    app,
    fit: row.fitScore,
  });
  return {
    dealId: created.id,
    companyId,
    contactId,
    ownerId,
    fitScore: row.fitScore,
    duplicate: false,
    existing: false,
  };
}

/** The system fields a lead is created with, its fit score among them. */
function attributionRow(input: LeadInput, app: VisApp | null, now: string) {
  const touch = input.attribution;
  const qualifier = input.qualifier ?? {};
  const role = qualifier.role ?? input.person.title ?? null;
  const fit = fitScore({
    product: input.product ?? null,
    country: qualifier.country ?? null,
    headcount: qualifier.headcount ?? null,
    role,
    erp: qualifier.erp ?? null,
    timelineMonths: qualifier.timelineMonths ?? null,
  });
  return {
    source: touch.source,
    campaign: touch.campaign ?? null,
    creativeId: touch.creativeId ?? null,
    firstTouchAt: touch.firstTouchAt ?? now,
    landingUrl: touch.landingUrl ?? null,
    utmSource: touch.utmSource ?? null,
    utmMedium: touch.utmMedium ?? null,
    gclid: touch.gclid ?? null,
    fbclid: touch.fbclid ?? null,
    ctwaClid: touch.ctwaClid ?? null,
    liFatId: touch.liFatId ?? null,
    consent: touch.consent ?? "UNKNOWN",
    consentAt: touch.consent === "GRANTED" ? (touch.consentAt ?? now) : null,
    product: input.product ?? null,
    orderType: input.orderType ?? "NEW",
    country: qualifier.country ?? null,
    headcount: qualifier.headcount ?? null,
    role,
    erp: qualifier.erp ?? null,
    timelineMonths: qualifier.timelineMonths ?? null,
    users: qualifier.users ?? null,
    fitScore: fit.score,
    fitReasons: fit.reasons,
    createdByApp: app,
    externalRef: input.externalRef ?? null,
  };
}

/**
 * Moves a deal to a named stage of its pipeline, exactly: the built-in
 * stage follows from the stage's kind and place, so reports keep counting.
 */
async function moveToStage(
  organizationId: string,
  input: { dealId: string; stage: string; reason?: string },
  app: VisApp | null,
  actorId?: string,
) {
  const found = await DealService.getDeal(organizationId, input.dealId);
  const pipeline = await requirePipeline(organizationId);
  const index = pipeline.stages.findIndex(
    (stage) => stage.name.toLowerCase() === input.stage.trim().toLowerCase(),
  );
  const target = pipeline.stages[index];
  if (!target) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${pipeline.name} has no stage "${input.stage}". Stages: ${pipeline.stages.map((stage) => stage.name).join(", ")}.`,
    );
  }
  const openPlace = pipeline.stages
    .slice(0, index)
    .filter((stage) => stage.kind === "OPEN").length;
  const builtIn =
    target.kind === "DONE"
      ? "CLOSED_WON"
      : target.kind === "DROPPED"
        ? "CLOSED_LOST"
        : (OPEN_DEAL_STAGES[Math.min(openPlace, OPEN_DEAL_STAGES.length - 1)] ??
          "DEMO_BOOKED");
  await DealService.setStage(
    organizationId,
    { id: input.dealId, stage: builtIn, closedReason: input.reason },
    actorId ?? found.owner.id,
  );
  await PipelineRepository.place(organizationId, input.dealId, {
    id: target.id,
    pipelineId: pipeline.id,
    kind: target.kind,
    stage: builtIn,
  });
  if (app) {
    await addNote(
      organizationId,
      input.dealId,
      `Moved to ${target.name}.`,
      app,
    );
  }
  console.log("[vis] stage set", {
    organizationId,
    dealId: input.dealId,
    stage: target.name,
    app,
  });
  return { dealId: input.dealId, stage: target.name };
}

/** A note on the deal, signed by the app that wrote it. */
async function addNote(
  organizationId: string,
  dealId: string,
  body: string,
  app: VisApp | null,
) {
  const found = await DealService.getDeal(organizationId, dealId);
  const id = await ActivityRepository.insert({
    organizationId,
    type: "NOTE",
    subject: app ? `From ${app}` : "Star CRM",
    body,
    occurredAt: new Date().toISOString(),
    dueAt: null,
    companyId: found.company.id,
    contactId: null,
    dealId,
    createdById: null,
  });
  return { id };
}

export const IntakeService = {
  setupPipeline,
  createLead,
  moveToStage,
  addNote,
};
