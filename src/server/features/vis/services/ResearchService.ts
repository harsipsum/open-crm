import { DealService } from "@/server/features/deals/services/DealService";
import { fitScore } from "@/server/features/vis/fitScore";
import { VisRepository } from "@/server/features/vis/repositories/VisRepository";
import { VisWorkRepository } from "@/server/features/vis/repositories/VisWorkRepository";
import { AppError } from "@/server/lib/errors";
import {
  COMPANY_TOOL,
  PERSON_TOOL,
  ProviderWait,
  companyLine,
  personLine,
  readCompany,
  readPerson,
  runInstant,
} from "@/server/features/vis/composioInstant";
import { PRODUCT_LABELS, type ResearchKind, type VisApp } from "@/shared/vis";
import type { ResearchFillInput } from "@/types/schemas/vis";

// The deal's Research tab. Cheap first, dear only once it's earned:
//
// - at intake, the company (Composio Instant LeadMagic, USD 0.02 a found
//   company) fills headcount and country the fit score reads;
// - at Qualified, the person (Composio Instant Prospeo: USD 0.024 a found
//   email, 0.245 a found mobile; no match is free), then the account brief,
//   written here from what the research found (no model, no cost).
//
// The CRM runs the calls itself through a Composio tool-router session when
// COMPOSIO_API_KEY is set and the Composio project has Instant on. Until then
// a request waits (PENDING, with the reason) and a sibling app with
// research:write fills it in: the relay. Either way each kind runs once per
// deal and its cost is kept, so the tab shows the cost per lead.

async function finish(
  organizationId: string,
  dealId: string,
  kind: ResearchKind,
  result: Parameters<typeof VisWorkRepository.completeResearch>[3],
) {
  const done = await VisWorkRepository.completeResearch(
    organizationId,
    dealId,
    kind,
    result,
  );
  if (done) await afterResearch(organizationId, dealId, kind);
  return done;
}

/** A company answer may know what the lead didn't say: the fit score rereads it. */
async function afterResearch(
  organizationId: string,
  dealId: string,
  kind: ResearchKind,
) {
  if (kind !== "COMPANY") return;
  const rows = await VisWorkRepository.research(organizationId, dealId);
  const found = readCompany(rows.find((row) => row.kind === "COMPANY")?.data);
  const lead = await VisRepository.attribution(organizationId, dealId);
  if (!found || !lead) return;
  const headcount = lead.headcount ?? found.headcount;
  const country = lead.country ?? found.country;
  const fit = fitScore({
    product: lead.product,
    country,
    headcount,
    role: lead.role,
    erp: lead.erp,
    timelineMonths: lead.timelineMonths,
  });
  await VisRepository.updateAttribution(organizationId, dealId, {
    headcount,
    country,
    fitScore: fit.score,
    fitReasons: fit.reasons,
  });
}

/** Runs a pending request through Composio; a wait leaves it pending. */
async function runRequest(
  organizationId: string,
  dealId: string,
  kind: "COMPANY" | "PERSON",
) {
  const found = await DealService.getDeal(organizationId, dealId);
  const lead = await VisRepository.attribution(organizationId, dealId);
  const people = await VisRepository.dealPeople(
    organizationId,
    dealId,
    lead?.contactId ?? null,
  );
  const domain = found.company.domain;
  // Claimed before any paid call: a retry overlapping the tick (or another
  // retry) finds it running and pays nothing.
  if (
    !(await VisWorkRepository.claimResearchRun(organizationId, dealId, kind))
  ) {
    return false;
  }
  try {
    if (kind === "COMPANY") {
      const args = domain
        ? { company_domain: domain }
        : { company_name: found.company.name };
      const answer = await runInstant(organizationId, COMPANY_TOOL, args);
      const company = answer.failed ? null : readCompany(answer.data);
      return finish(organizationId, dealId, kind, {
        status: answer.failed ? "FAILED" : company ? "DONE" : "NOT_FOUND",
        provider: "composio-instant:leadmagic",
        tool: COMPANY_TOOL,
        costUsd: answer.costUsd,
        summary: company ? companyLine(company) : "No company match.",
        data: answer.data,
        error: answer.failed,
        filledByApp: null,
      });
    }
    // The attributed lead, whose research it is.
    const lead0 =
      people.find((person) => person.id === lead?.contactId) ?? people[0];
    const answer = await runInstant(organizationId, PERSON_TOOL, {
      person: {
        first_name: lead0?.firstName,
        last_name: lead0?.lastName ?? undefined,
        ...(domain
          ? { company_website: domain }
          : { company_name: found.company.name }),
      },
      enrich_mobile: true,
    });
    const person = answer.failed ? null : readPerson(answer.data);
    return finish(organizationId, dealId, kind, {
      status: answer.failed ? "FAILED" : person ? "DONE" : "NOT_FOUND",
      provider: "composio-instant:prospeo",
      tool: PERSON_TOOL,
      costUsd: answer.costUsd,
      summary: person ? personLine(person) : "No person match (free).",
      data: answer.data,
      error: answer.failed,
      filledByApp: null,
    });
  } catch (error) {
    // The claim is released with the reason; it waits for the relay or a
    // person, never a loop.
    await VisWorkRepository.noteResearchWait(
      organizationId,
      dealId,
      kind,
      error instanceof ProviderWait
        ? error.message
        : "The research call failed; ask again from the deal.",
    );
    if (error instanceof ProviderWait) return false;
    throw error;
  }
}

/** Why now, by product: the dated trigger the SDR opens with. */
function trigger(product: string | null, country: string | null) {
  const ksa = /saudi|ksa|^sa$/i.test(country ?? "");
  if (product === "CLEARTAX") {
    return ksa
      ? "ZATCA Phase 2 integration waves: are they live, and on which ERP?"
      : "UAE e-invoicing: AED 50M+ businesses go live from Jan 2027 and must appoint an accredited provider before then.";
  }
  if (product === "ASANA") {
    return "Projects run in spreadsheets, email or Monday.com: land small, grow by team.";
  }
  if (product === "FRESHWORKS") {
    return "An IT or support desk without targets: response times are the opener.";
  }
  return "Ask what triggered the enquiry.";
}

/** The account brief: what the research found, laid out for the call. */
async function writeBrief(organizationId: string, dealId: string) {
  await VisWorkRepository.requestResearch(organizationId, dealId, "BRIEF");
  const found = await DealService.getDeal(organizationId, dealId);
  const lead = await VisRepository.attribution(organizationId, dealId);
  const rows = await VisWorkRepository.research(organizationId, dealId);
  const company = readCompany(rows.find((row) => row.kind === "COMPANY")?.data);
  const person = readPerson(rows.find((row) => row.kind === "PERSON")?.data);
  const people = await VisRepository.dealPeople(
    organizationId,
    dealId,
    lead?.contactId ?? null,
  );
  const contact = people[0];
  const product = lead?.product ? PRODUCT_LABELS[lead.product] : "Not named";
  const sections = {
    account: company
      ? companyLine(company)
      : `${found.company.name} (no company match)`,
    whyNow: trigger(
      lead?.product ?? null,
      lead?.country ?? company?.country ?? null,
    ),
    whoToCall: contact
      ? [
          [contact.firstName, contact.lastName].filter(Boolean).join(" "),
          contact.title ?? person?.title,
          contact.phone ?? person?.mobile ?? "no phone yet",
        ]
          .filter(Boolean)
          .join(", ")
      : "No contact on the deal",
    fit: `${lead?.fitScore ?? 0}/100: ${(lead?.fitReasons ?? []).join("; ")}`,
    product: `${product}, ${lead?.orderType ?? "NEW"}${lead?.users ? `, ${lead.users} users` : ""}`,
    source: lead
      ? [lead.source, lead.campaign, lead.creativeId]
          .filter(Boolean)
          .join(", ")
      : "Unknown",
  };
  await finish(organizationId, dealId, "BRIEF", {
    status: "DONE",
    provider: "viscrm",
    tool: null,
    costUsd: 0,
    summary: `${sections.account}. ${sections.whyNow}`,
    data: sections,
    error: null,
    filledByApp: null,
  });
}

/** A sibling app ran the research: its answer goes in, once. */
async function fill(
  organizationId: string,
  input: ResearchFillInput,
  app: VisApp,
) {
  await DealService.getDeal(organizationId, input.dealId);
  await VisWorkRepository.requestResearch(
    organizationId,
    input.dealId,
    input.kind,
  );
  const done = await finish(organizationId, input.dealId, input.kind, {
    status: input.status,
    provider: input.provider,
    tool: input.tool ?? null,
    costUsd: input.costUsd,
    summary: input.summary ?? null,
    data: input.data ?? null,
    error: input.error ?? null,
    filledByApp: app,
  });
  if (!done) {
    throw new AppError(
      "CONFLICT",
      `The ${input.kind.toLowerCase()} research on this deal is already done.`,
    );
  }
  return { dealId: input.dealId, kind: input.kind, status: input.status };
}

/**
 * What the tick does for one deal, by where it stands. Each paid call is
 * tried once, when its request opens: a request left waiting is never
 * retried in a loop (no burn); the relay fills it, or a person asks again
 * (`retry`).
 */
async function advance(
  organizationId: string,
  dealId: string,
  qualified: boolean,
) {
  if (
    await VisWorkRepository.requestResearch(organizationId, dealId, "COMPANY")
  ) {
    await runRequest(organizationId, dealId, "COMPANY");
  }
  if (!qualified) return;
  if (
    await VisWorkRepository.requestResearch(organizationId, dealId, "PERSON")
  ) {
    await runRequest(organizationId, dealId, "PERSON");
  }
  const rows = await VisWorkRepository.research(organizationId, dealId);
  const person = rows.find((row) => row.kind === "PERSON");
  const brief = rows.find((row) => row.kind === "BRIEF");
  if (person && person.status !== "PENDING" && !brief) {
    await writeBrief(organizationId, dealId);
  }
}

/** A person asks again for research that is still waiting. */
async function retry(organizationId: string, dealId: string) {
  const rows = await VisWorkRepository.research(organizationId, dealId);
  const waiting = rows.filter(
    (row) =>
      row.status === "PENDING" &&
      (row.kind === "COMPANY" || row.kind === "PERSON"),
  );
  for (const row of waiting) {
    if (row.kind === "COMPANY" || row.kind === "PERSON") {
      await runRequest(organizationId, dealId, row.kind);
    }
  }
  return { retried: waiting.map((row) => row.kind) };
}

export const ResearchService = { advance, fill, retry };
