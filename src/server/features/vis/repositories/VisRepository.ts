import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
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
  visAppKey,
} from "@/db/schema";
import type { VisApp } from "@/shared/vis";
// Every read and write takes the organization and filters by it, including
// lookups by id (AGENTS.md, Tenancy). The one exception is `keyByHash`: an
// incoming key names its organization, so the hash is the lookup.

type NewAttribution = typeof dealAttribution.$inferInsert;

// --- App keys ---------------------------------------------------------------

async function insertKey(values: typeof visAppKey.$inferInsert) {
  await db.insert(visAppKey).values(values);
}

/** The live key with this hash, whoever's it is: the key names its org. */
async function keyByHash(keyHash: string) {
  const [found] = await db
    .select()
    .from(visAppKey)
    .where(and(eq(visAppKey.keyHash, keyHash), isNull(visAppKey.revokedAt)))
    .limit(1);
  return found ?? null;
}

async function touchKey(organizationId: string, id: string, at: string) {
  await db
    .update(visAppKey)
    .set({ lastUsedAt: at })
    .where(
      and(eq(visAppKey.organizationId, organizationId), eq(visAppKey.id, id)),
    );
}

async function listKeys(organizationId: string) {
  return db
    .select({
      id: visAppKey.id,
      app: visAppKey.app,
      label: visAppKey.label,
      keyPrefix: visAppKey.keyPrefix,
      lastUsedAt: visAppKey.lastUsedAt,
      revokedAt: visAppKey.revokedAt,
      createdAt: visAppKey.createdAt,
    })
    .from(visAppKey)
    .where(eq(visAppKey.organizationId, organizationId))
    .orderBy(desc(visAppKey.createdAt));
}

/** Revokes the app's live key; true when there was one. */
async function revokeKey(organizationId: string, app: VisApp, at: string) {
  const revoked = await db
    .update(visAppKey)
    .set({ revokedAt: at })
    .where(
      and(
        eq(visAppKey.organizationId, organizationId),
        eq(visAppKey.app, app),
        isNull(visAppKey.revokedAt),
      ),
    )
    .returning({ id: visAppKey.id });
  return revoked.length > 0;
}

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
async function trackedDeals(organizationId: string) {
  return db
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
      ),
    );
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
async function releaseHandoff(organizationId: string, dealId: string) {
  await db
    .delete(asanaHandoff)
    .where(
      and(
        eq(asanaHandoff.organizationId, organizationId),
        eq(asanaHandoff.dealId, dealId),
      ),
    );
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
  insertKey,
  keyByHash,
  touchKey,
  listKeys,
  revokeKey,
  liveCompanyByDomain,
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
  releaseHandoff,
  handoff,
  dealPeople,
};
