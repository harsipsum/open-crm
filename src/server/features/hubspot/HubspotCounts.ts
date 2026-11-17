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
export async function counts(org: string, portal: string) {
  const rows = await db
    .select({
      objectType: hubspotObject.objectType,
      count: sql<number>`count(*)`,
      active: sql<number>`sum(case when json_extract(data,'$.archived') = 1 then 0 else 1 end)`,
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
    const [found] = await db
      .select({ count: sql<number>`count(*)` })
      .from(hubspotObject)
      .innerJoin(
        table,
        and(
          eq(table.id, hubspotObject.targetId),
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
  }
  return { objects: rows, projections, associations: edges?.count ?? 0 };
}
