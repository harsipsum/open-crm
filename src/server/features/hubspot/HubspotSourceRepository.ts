import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { hubspotObject } from "@/db/schema";

async function dealProperties(organizationId: string, dealId: string) {
  const [row] = await db
    .select({ data: hubspotObject.data })
    .from(hubspotObject)
    .where(
      and(
        eq(hubspotObject.organizationId, organizationId),
        eq(hubspotObject.objectType, "deals"),
        eq(hubspotObject.targetId, dealId),
      ),
    )
    .limit(1);
  return row
    ? z
        .object({ properties: z.record(z.string(), z.string().nullable()) })
        .parse(row.data).properties
    : {};
}
export const HubspotSourceRepository = { dealProperties };
