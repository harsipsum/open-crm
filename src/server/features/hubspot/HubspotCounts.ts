import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  hubspotObject,
  hubspotAssociation,
  company,
  contact,
  deal,
  activity,
} from "@/db/schema";
import { target } from "./hubspotValues";
export async function counts(org: string, portal: string) {
  const rows = await db
    .select({
      objectType: hubspotObject.objectType,
      count: sql<number>`count(*)`,
      active: sql<number>`count(*)`,
    })
    .from(hubspotObject)
    .where(
      and(
        eq(hubspotObject.organizationId, org),
        eq(hubspotObject.portalId, portal),
      ),
    )
    .groupBy(hubspotObject.objectType);
  const [edges] = await db
    .select({ count: sql<number>`count(*)` })
    .from(hubspotAssociation)
    .where(
      and(
        eq(hubspotAssociation.organizationId, org),
        eq(hubspotAssociation.portalId, portal),
      ),
    );
  const projections: Record<string, number> = {};
  for (const [kind, table] of [
    ["companies", company],
    ["contacts", contact],
    ["deals", deal],
    ["notes", activity],
  ] as const) {
    // The source key is a covering index. Avoid reading every full-property
    // JSON blob (hundreds of MB at CRM scale) merely to count imported rows.
    const active =
      kind === "notes"
        ? sql<number>`coalesce(sum(case when json_extract(${hubspotObject.data},'$.archived') = 1 then 0 else 1 end),0)`
        : sql<number>`coalesce(sum(case when ${table.archivedAt} is null then 1 else 0 end),0)`;
    const [found] = await db
      .select({ count: sql<number>`count(*)`, active })
      .from(hubspotObject)
      .innerJoin(
        table,
        and(
          eq(
            table.id,
            sql<string>`(${target(org, portal, kind, "")} || ${hubspotObject.sourceId})`,
          ),
          eq(table.organizationId, org),
        ),
      )
      .where(
        and(
          eq(hubspotObject.organizationId, org),
          eq(hubspotObject.portalId, portal),
          eq(hubspotObject.objectType, kind),
        ),
      );
    projections[kind] = found?.count ?? 0;
    const row = rows.find((candidate) => candidate.objectType === kind);
    if (row) row.active = found?.active ?? 0;
  }
  const [owners] = await db
    .select({
      active: sql<number>`coalesce(sum(case when json_extract(${hubspotObject.data},'$.archived') = 1 then 0 else 1 end),0)`,
    })
    .from(hubspotObject)
    .where(
      and(
        eq(hubspotObject.organizationId, org),
        eq(hubspotObject.portalId, portal),
        eq(hubspotObject.objectType, "owners"),
      ),
    );
  const ownerRow = rows.find((row) => row.objectType === "owners");
  if (ownerRow) ownerRow.active = owners?.active ?? 0;
  return { objects: rows, projections, associations: edges?.count ?? 0 };
}
