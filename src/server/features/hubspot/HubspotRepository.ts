import { counts } from "./HubspotCounts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  activity,
  company,
  contact,
  deal,
  dealContact,
  hubspotAssociation,
  hubspotObject,
  member,
  user,
} from "@/db/schema";
import type {
  HubspotAssociations,
  HubspotBatch,
} from "@/types/schemas/hubspot";

import { date, lookup, rawProperties, target, text } from "./hubspotValues";
import { metadataWrite } from "./HubspotMetadata";

async function prepare(org: string, portal: string) {
  const companyId = target(org, portal, "system", "unassociated-company");
  const userId = target(org, portal, "system", "unassigned-owner");
  await runBatch((tx) => [
    tx
      .insert(company)
      .values({
        id: companyId,
        organizationId: org,
        name: "HubSpot: no associated company",
        source: "IMPORT",
        researchHeldAt: new Date().toISOString(),
      })
      .onConflictDoNothing(),
    tx
      .insert(user)
      .values({
        id: userId,
        name: "Unassigned HubSpot owner",
        email: `${encodeURIComponent(org)}.${portal}.unassigned@import.invalid`,
      })
      .onConflictDoNothing(),
    tx
      .insert(member)
      .values({
        id: userId,
        organizationId: org,
        userId,
        role: "member",
        createdAt: new Date(0),
      })
      .onConflictDoNothing(),
  ]);
  return { companyId, userId };
}

// All unknown properties remain in hubspot_object.data. Native fields are a
// projection only; a duplicate domain/email is retained in that blob rather
// than collapsing two source IDs into one CRM row.
async function writeObjects(org: string, input: HubspotBatch) {
  const { portalId: portal, objectType: kind, records } = input;
  if (!records.length) return { received: 0, created: 0 };
  if (kind === "owners" && records.length > 1) {
    let created = 0;
    for (const record of records)
      created += (await writeObjects(org, { ...input, records: [record] }))
        .created;
    return { received: records.length, created };
  }
  const existing = await db
    .select({ id: hubspotObject.sourceId })
    .from(hubspotObject)
    .where(
      and(
        eq(hubspotObject.organizationId, org),
        eq(hubspotObject.portalId, portal),
        eq(hubspotObject.objectType, kind),
        inArray(
          hubspotObject.sourceId,
          records.map((r) => r.id),
        ),
      ),
    );
  const defaults = kind === "deals" ? await prepare(org, portal) : null;
  const now = new Date().toISOString();
  const writes: Promise<unknown>[] = [];
  for (const row of records) {
    const p = rawProperties(row);
    let id = target(org, portal, kind, row.id);
    const createdAt =
      date(row.createdAt ?? p.createdate ?? p.hs_createdate) ?? now;
    const updatedAt =
      date(row.updatedAt ?? p.lastmodifieddate ?? p.hs_lastmodifieddate) ??
      createdAt;
    // Start the destination retention clock now, not on an old source date.
    const archivedAt = row.archived ? now : null;
    const ownerId = lookup(org, portal, "owners", p.hubspot_owner_id ?? null);
    const metadata = await metadataWrite({ org, portal, kind, row, createdAt });
    if (metadata) {
      id = metadata.id;
      writes.push(...metadata.writes);
    } else if (kind === "companies") {
      const domain = text(p.domain)?.toLowerCase() ?? null;
      const value = {
        id,
        organizationId: org,
        // A company HubSpot holds with no name reads as its domain, never as an id.
        name: text(p.name) ?? domain ?? `HubSpot company ${row.id}`,
        domain: sql<
          string | null
        >`case when exists(select 1 from company where organization_id = ${org} and domain = ${domain} and archived_at is null and id <> ${id}) then null else ${domain} end`,
        website: text(p.website),
        phone: text(p.phone),
        description: text(p.description),
        industry: text(p.industry),
        city: text(p.city),
        stateCode: text(p.state),
        country: text(p.country),
        ownerId,
        source: "IMPORT" as const,
        researchHeldAt: now,
        createdAt,
        updatedAt,
        archivedAt,
      };
      writes.push(
        db
          .insert(company)
          .values(value)
          .onConflictDoUpdate({
            target: company.id,
            set: value,
            setWhere: eq(company.organizationId, org),
          }),
      );
    } else if (kind === "contacts") {
      const email = text(p.email)?.toLowerCase() ?? null;
      const value = {
        id,
        organizationId: org,
        firstName: text(p.firstname) ?? "(unnamed)",
        lastName: text(p.lastname),
        email: sql<
          string | null
        >`case when exists(select 1 from contact where organization_id = ${org} and email = ${email} and archived_at is null and id <> ${id}) then null else ${email} end`,
        phone: text(p.phone) ?? text(p.mobilephone),
        title: text(p.jobtitle),
        ownerId,
        source: "IMPORT" as const,
        researchHeldAt: now,
        createdAt,
        updatedAt,
        archivedAt,
      };
      writes.push(
        db
          .insert(contact)
          .values(value)
          .onConflictDoUpdate({
            target: contact.id,
            set: value,
            setWhere: eq(contact.organizationId, org),
          }),
      );
    } else if (kind === "deals" && defaults) {
      const stageId = lookup(
        org,
        portal,
        "stages",
        `${p.pipeline}:${p.dealstage}`,
      );
      const stage = sql<
        (typeof deal.$inferInsert)["stage"]
      >`coalesce((select json_extract(data, '$.builtInStage') from hubspot_object where organization_id = ${org} and portal_id = ${portal} and object_type = 'stages' and source_id = ${`${p.pipeline}:${p.dealstage}`}), 'UNMAPPED')`;
      const n = Number(p.amount);
      const amount = p.amount && Number.isFinite(n) ? n : null;
      const currency = text(p.deal_currency_code) ?? "USD";
      const value = {
        id,
        organizationId: org,
        name: text(p.dealname) ?? `HubSpot deal ${row.id}`,
        description: text(p.description),
        companyId: sql<string>`coalesce((select company_id from deal where organization_id = ${org} and id = ${id}), ${defaults.companyId})`,
        ownerId: sql<string>`coalesce(${ownerId}, ${defaults.userId})`,
        stage,
        pipelineId: lookup(org, portal, "pipelines", p.pipeline ?? null),
        pipelineStageId: stageId,
        amount,
        currency,
        expectedCloseDate: date(p.closedate),
        closedAt: sql<
          string | null
        >`case when ${stage} in ('CLOSED_WON','CLOSED_LOST') then ${date(p.closedate) ?? updatedAt} else null end`,
        stageChangedAt: date(p.hs_lastmodifieddate) ?? updatedAt,
        source: "IMPORT" as const,
        createdAt,
        updatedAt,
        archivedAt,
      };
      writes.push(
        db
          .insert(deal)
          .values(value)
          .onConflictDoUpdate({
            target: deal.id,
            set: value,
            setWhere: eq(deal.organizationId, org),
          }),
      );
    } else if (kind === "notes") {
      const value = {
        id,
        organizationId: org,
        type: "NOTE" as const,
        subject: "HubSpot note",
        body: p.hs_note_body ?? "",
        occurredAt: date(p.hs_timestamp) ?? createdAt,
        createdById: ownerId,
        meta: {
          source: "HUBSPOT",
          portalId: portal,
          sourceId: row.id,
          archived: Boolean(row.archived),
        },
        createdAt,
        updatedAt,
      };
      writes.push(
        db
          .insert(activity)
          .values(value)
          .onConflictDoUpdate({
            target: activity.id,
            set: value,
            setWhere: eq(activity.organizationId, org),
          }),
      );
    }
    writes.push(
      db
        .insert(hubspotObject)
        .values({
          organizationId: org,
          portalId: portal,
          objectType: kind,
          sourceId: row.id,
          targetId: id,
          data: row,
          importedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            hubspotObject.organizationId,
            hubspotObject.portalId,
            hubspotObject.objectType,
            hubspotObject.sourceId,
          ],
          set: { targetId: id, data: row, importedAt: now },
        }),
    );
  }
  await runBatch(() => writes);
  return {
    received: records.length,
    created: records.length - existing.length,
  };
}

async function writeAssociations(org: string, input: HubspotAssociations) {
  const { portalId: portal } = input;
  // Keep D1 requests bounded even when each association projects two writes.
  for (let start = 0; start < input.records.length; start += 25) {
    const writes: Promise<unknown>[] = [];
    for (const r of input.records.slice(start, start + 25)) {
      const from = target(org, portal, r.fromType, r.fromId);
      const to = target(org, portal, r.toType, r.toId);
      writes.push(
        db
          .insert(hubspotAssociation)
          .values({ ...r, organizationId: org, portalId: portal })
          .onConflictDoUpdate({
            target: [
              hubspotAssociation.organizationId,
              hubspotAssociation.portalId,
              hubspotAssociation.fromType,
              hubspotAssociation.fromId,
              hubspotAssociation.toType,
              hubspotAssociation.toId,
              hubspotAssociation.category,
              hubspotAssociation.typeId,
            ],
            set: { label: r.label },
          }),
      );
      const isPrimary =
        /primary/i.test(r.label ?? "") || ["1", "5"].includes(r.typeId);
      if (r.fromType === "contacts" && r.toType === "companies") {
        writes.push(
          db
            .update(contact)
            .set({ companyId: to })
            .where(
              and(
                eq(contact.organizationId, org),
                eq(contact.id, from),
                sql`exists(select 1 from company where organization_id = ${org} and id = ${to})`,
                isPrimary ? sql`1` : sql`${contact.companyId} is null`,
              ),
            ),
        );
      } else if (r.fromType === "deals" && r.toType === "companies") {
        writes.push(
          db
            .update(deal)
            .set({ companyId: to })
            .where(
              and(
                eq(deal.organizationId, org),
                eq(deal.id, from),
                sql`exists(select 1 from company where organization_id = ${org} and id = ${to})`,
                isPrimary
                  ? sql`1`
                  : eq(
                      deal.companyId,
                      target(org, portal, "system", "unassociated-company"),
                    ),
              ),
            ),
        );
      } else if (r.fromType === "deals" && r.toType === "contacts") {
        // Both rows must exist in this organization. Dangling source edges
        // still survive in the lossless association table.
        writes.push(
          db
            .insert(dealContact)
            .select(
              db
                .select({
                  dealId: deal.id,
                  contactId: contact.id,
                  organizationId: deal.organizationId,
                  role: sql<string | null>`${r.label}`.as("role"),
                })
                .from(deal)
                .innerJoin(
                  contact,
                  eq(contact.organizationId, deal.organizationId),
                )
                .where(
                  and(
                    eq(deal.organizationId, org),
                    eq(deal.id, from),
                    eq(contact.id, to),
                  ),
                ),
            )
            .onConflictDoNothing(),
        );
      } else if (r.fromType === "notes") {
        const field =
          r.toType === "companies"
            ? "companyId"
            : r.toType === "contacts"
              ? "contactId"
              : r.toType === "deals"
                ? "dealId"
                : null;
        const table =
          r.toType === "companies"
            ? company
            : r.toType === "contacts"
              ? contact
              : deal;
        if (field) {
          writes.push(
            db
              .update(activity)
              .set({ [field]: to })
              .where(
                and(
                  eq(activity.organizationId, org),
                  eq(activity.id, from),
                  sql`exists(select 1 from ${table} where ${table.organizationId} = ${org} and ${table.id} = ${to})`,
                ),
              ),
          );
        }
      }
    }
    await runBatch(() => writes);
  }
  return { received: input.records.length };
}

export const HubspotRepository = { writeObjects, writeAssociations, counts };
