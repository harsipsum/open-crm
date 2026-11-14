import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { sortBy } from "remeda";
import { db } from "@/db";
import {
  asanaHandoff,
  company,
  contact,
  deal,
  dealAttribution,
  dealContact,
  dealOrder,
  pipeline,
  pipelineStage,
  suppressedContact,
  suppressedDomain,
} from "@/db/schema";
import type { VisApp } from "@/shared/vis";

// Every read and write takes the organization and filters by it, including
// lookups by id (AGENTS.md, Tenancy). The one exception is `keyByHash`: an
// incoming key names its organization, so the hash is the lookup.

type NewAttribution = typeof dealAttribution.$inferInsert;

// --- Records the intake reuses ---------------------------------------------

async function liveCompanyByDomain(organizationId: string, domain: string) {
  const [found] = await db
    .select({ id: company.id, name: company.name })
    .from(company)
    .where(
      and(
        eq(company.organizationId, organizationId),
        eq(company.domain, domain),
        isNull(company.archivedAt),
      ),
    )
    .limit(1);
  return found ?? null;
}

/** The live contact with this email, and the company they work at. */
async function liveContactByEmail(organizationId: string, email: string) {
  const [found] = await db
    .select({ id: contact.id, companyId: contact.companyId })
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, organizationId),
        eq(contact.email, email),
        isNull(contact.archivedAt),
      ),
    )
    .limit(1);
  return found ?? null;
}

/**
 * The live contact with this phone (E.164 from phoneKey), however it was
 * typed: spaces, dashes, brackets and a 00 prefix are ignored.
 */
async function liveContactByPhone(organizationId: string, phone: string) {
  const digits = phone.replace(/\D/g, "");
  const stored = sql`replace(replace(replace(replace(replace(${contact.phone}, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')`;
  const [found] = await db
    .select({ id: contact.id, companyId: contact.companyId })
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, organizationId),
        isNull(contact.archivedAt),
        or(eq(stored, digits), eq(stored, `00${digits}`)),
      ),
    )
    .limit(1);
  return found ?? null;
}

/**
 * The person's VisCRM deals, newest first: still open, or every one when
 * `openOnly` is false.
 */
async function leadDeals(
  organizationId: string,
  contactId: string,
  openOnly: boolean,
) {
  return db
    .select({
      dealId: deal.id,
      name: deal.name,
      stage: pipelineStage.name,
      product: dealAttribution.product,
      source: dealAttribution.source,
      fitScore: dealAttribution.fitScore,
      closedAt: deal.closedAt,
      createdAt: dealAttribution.createdAt,
    })
    .from(dealAttribution)
    .innerJoin(deal, eq(deal.id, dealAttribution.dealId))
    .leftJoin(pipelineStage, eq(pipelineStage.id, deal.pipelineStageId))
    .where(
      and(
        eq(dealAttribution.organizationId, organizationId),
        eq(deal.organizationId, organizationId),
        eq(dealAttribution.contactId, contactId),
        isNull(deal.archivedAt),
        openOnly ? isNull(deal.closedAt) : undefined,
      ),
    )
    .orderBy(desc(dealAttribution.createdAt));
}

/** The lead an app already sent under this reference, if any. */
async function attributionByRef(
  organizationId: string,
  app: VisApp | null,
  externalRef: string,
) {
  const [found] = await db
    .select({
      dealId: dealAttribution.dealId,
      contactId: dealAttribution.contactId,
      fitScore: dealAttribution.fitScore,
    })
    .from(dealAttribution)
    .where(
      and(
        eq(dealAttribution.organizationId, organizationId),
        eq(dealAttribution.externalRef, externalRef),
        app
          ? eq(dealAttribution.createdByApp, app)
          : isNull(dealAttribution.createdByApp),
      ),
    )
    .limit(1);
  return found ?? null;
}

/** The pipeline of this name and its stages, in order. */
async function pipelineByName(organizationId: string, name: string) {
  const [found] = await db
    .select({ id: pipeline.id, name: pipeline.name })
    .from(pipeline)
    .where(
      and(
        eq(pipeline.organizationId, organizationId),
        sql`lower(${pipeline.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  if (!found) return null;
  const stages = await db
    .select({
      id: pipelineStage.id,
      name: pipelineStage.name,
      kind: pipelineStage.kind,
      position: pipelineStage.position,
    })
    .from(pipelineStage)
    .where(
      and(
        eq(pipelineStage.organizationId, organizationId),
        eq(pipelineStage.pipelineId, found.id),
      ),
    )
    .orderBy(asc(pipelineStage.position));
  return { ...found, stages };
}

// --- Attribution -------------------------------------------------------------

async function insertAttribution(values: NewAttribution) {
  await db.insert(dealAttribution).values(values);
}

async function attribution(organizationId: string, dealId: string) {
  const [found] = await db
    .select()
    .from(dealAttribution)
    .where(
      and(
        eq(dealAttribution.organizationId, organizationId),
        eq(dealAttribution.dealId, dealId),
      ),
    )
    .limit(1);
  return found ?? null;
}

async function updateAttribution(
  organizationId: string,
  dealId: string,
  patch: Partial<NewAttribution>,
) {
  await db
    .update(dealAttribution)
    .set(patch)
    .where(
      and(
        eq(dealAttribution.organizationId, organizationId),
        eq(dealAttribution.dealId, dealId),
      ),
    );
}

/**
 * The deals VisCRM tracks (those its intake created), with where each sits
 * in its pipeline: what the tick walks.
 */
/** Deals closed longer ago than this are done: the tick leaves them alone. */
const SETTLED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many deals a tick, newest first. */
const TICK_LIMIT = 500;

/**
 * VisCRM's deals. With `now` (the tick), only those still in play: open,
 * or closed within the last 7 days, at most 500, newest first, so a tick's
 * work stays bounded however long the history grows.
 */
async function trackedDeals(organizationId: string, now?: string) {
  const cutoff = now
    ? new Date(Date.parse(now) - SETTLED_AFTER_MS).toISOString()
    : null;
  const query = db
    .select({
      id: deal.id,
      name: deal.name,
      stage: deal.stage,
      amount: deal.amount,
      currency: deal.currency,
      closedAt: deal.closedAt,
      ownerId: deal.ownerId,
      companyId: deal.companyId,
      pipelineId: deal.pipelineId,
      stageName: pipelineStage.name,
      stagePosition: pipelineStage.position,
      stageKind: pipelineStage.kind,
    })
    .from(dealAttribution)
    .innerJoin(deal, eq(deal.id, dealAttribution.dealId))
    .leftJoin(pipelineStage, eq(pipelineStage.id, deal.pipelineStageId))
    .where(
      and(
        eq(dealAttribution.organizationId, organizationId),
        eq(deal.organizationId, organizationId),
        isNull(deal.archivedAt),
        cutoff
          ? or(isNull(deal.closedAt), gte(deal.closedAt, cutoff))
          : undefined,
      ),
    );
  return cutoff
    ? query.orderBy(desc(dealAttribution.createdAt)).limit(TICK_LIMIT)
    : query;
}

/** The organizations with tracked deals: the ones a tick has work for. */
async function organizationsWithLeads() {
  const rows = await db
    .selectDistinct({ organizationId: dealAttribution.organizationId })
    .from(dealAttribution);
  return rows.map((row) => row.organizationId);
}

// --- Order -------------------------------------------------------------------

type OrderPatch = Omit<
  typeof dealOrder.$inferInsert,
  "dealId" | "organizationId" | "updatedAt"
>;

async function upsertOrder(
  organizationId: string,
  dealId: string,
  patch: OrderPatch,
) {
  const updatedAt = new Date().toISOString();
  await db
    .insert(dealOrder)
    .values({ organizationId, dealId, ...patch, updatedAt })
    .onConflictDoUpdate({
      target: dealOrder.dealId,
      set: { ...patch, updatedAt },
      setWhere: eq(dealOrder.organizationId, organizationId),
    });
}

async function order(organizationId: string, dealId: string) {
  const [found] = await db
    .select()
    .from(dealOrder)
    .where(
      and(
        eq(dealOrder.organizationId, organizationId),
        eq(dealOrder.dealId, dealId),
      ),
    )
    .limit(1);
  return found ?? null;
}

// --- Asana handoff -----------------------------------------------------------

/** Claims the deal's handoff; false when it was already handed off. */
async function claimHandoff(
  organizationId: string,
  dealId: string,
  projectGid: string,
) {
  const inserted = await db
    .insert(asanaHandoff)
    .values({ organizationId, dealId, projectGid })
    .onConflictDoNothing()
    .returning({ dealId: asanaHandoff.dealId });
  return inserted.length > 0;
}

async function finishHandoff(
  organizationId: string,
  dealId: string,
  result: {
    taskGid: string | null;
    taskUrl: string | null;
    error: string | null;
  },
) {
  await db
    .update(asanaHandoff)
    .set(result)
    .where(
      and(
        eq(asanaHandoff.organizationId, organizationId),
        eq(asanaHandoff.dealId, dealId),
      ),
    );
}

/** A failed handoff is let go, so the next tick tries again. */
/**
 * Lets go of a failed handoff so it can be tried again: only one that
 * recorded an error and made no task, never one still in flight.
 */
async function releaseFailedHandoff(organizationId: string, dealId: string) {
  const released = await db
    .delete(asanaHandoff)
    .where(
      and(
        eq(asanaHandoff.organizationId, organizationId),
        eq(asanaHandoff.dealId, dealId),
        isNull(asanaHandoff.taskGid),
        isNotNull(asanaHandoff.error),
      ),
    )
    .returning({ dealId: asanaHandoff.dealId });
  return released.length > 0;
}

/** Whether a person deleted forever (or their domain) may not come back by itself. */
async function isSuppressed(
  organizationId: string,
  email: string | null,
  domain: string | null,
) {
  const [person] = email
    ? await db
        .select({ email: suppressedContact.email })
        .from(suppressedContact)
        .where(
          and(
            eq(suppressedContact.organizationId, organizationId),
            eq(suppressedContact.email, email),
          ),
        )
        .limit(1)
    : [];
  const [place] = domain
    ? await db
        .select({ domain: suppressedDomain.domain })
        .from(suppressedDomain)
        .where(
          and(
            eq(suppressedDomain.organizationId, organizationId),
            eq(suppressedDomain.domain, domain),
          ),
        )
        .limit(1)
    : [];
  return Boolean(person || place);
}

async function handoff(organizationId: string, dealId: string) {
  const [found] = await db
    .select()
    .from(asanaHandoff)
    .where(
      and(
        eq(asanaHandoff.organizationId, organizationId),
        eq(asanaHandoff.dealId, dealId),
      ),
    )
    .limit(1);
  return found ?? null;
}

/** The deal's contacts, primary lead first, for the handoff and the brief. */
async function dealPeople(
  organizationId: string,
  dealId: string,
  leadId: string | null,
) {
  const rows = await db
    .select({
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      title: contact.title,
      linkedinUrl: contact.linkedinUrl,
      role: dealContact.role,
    })
    .from(dealContact)
    .innerJoin(contact, eq(contact.id, dealContact.contactId))
    .where(
      and(
        eq(dealContact.organizationId, organizationId),
        eq(dealContact.dealId, dealId),
        eq(contact.organizationId, organizationId),
      ),
    );
  return sortBy(rows, (row) => (row.id === leadId ? 0 : 1));
}

export const VisRepository = {
  liveCompanyByDomain,
  liveContactByEmail,
  liveContactByPhone,
  leadDeals,
  attributionByRef,
  pipelineByName,
  insertAttribution,
  attribution,
  updateAttribution,
  trackedDeals,
  organizationsWithLeads,
  upsertOrder,
  order,
  claimHandoff,
  finishHandoff,
  releaseFailedHandoff,
  handoff,
  dealPeople,
  isSuppressed,
};
